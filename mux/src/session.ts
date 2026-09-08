/**
 * ▲ UserSession — один юзер = одно подключение к пиннутому селлеру.
 *
 * Провод-совместимая сборка из публичных модулей @antseed/* — повторяет
 * wiring AntseedNode (node.js:1340-1420, 1716-1800), но без DHT, discovery,
 * router и listener'ов. Весь трафик: encrypted TCP к нашему селлеру.
 *
 * Память: ~5-15MB на сессию (TCP socket + wallet + channel state) против
 * ~190MB полного CLI buyer-процесса. Сотни юзеров на процесс.
 */
import { EventEmitter } from "node:events";
import { join } from "node:path";
import {
  ConnectionState,
  ChannelStore,
  type Identity,
} from "@antseed/node";
import {
  ConnectionManager,
  KeepaliveManager,
  buildPongPayload,
  encodeFrame,
  FrameDecoder,
  type PeerConnection,
} from "@antseed/node/p2p";
import { MessageType } from "@antseed/protocol/messages";
import type { SerializedHttpRequest, SerializedHttpResponse, SerializedHttpResponseChunk } from "@antseed/protocol/http";
import {
  ProxyMux,
  PaymentMux,
  BuyerPaymentManager,
  BuyerPaymentNegotiator,
  BuyerRequestHandler,
  DepositsClient,
  ChannelsClient,
  type BuyerPeerView,
  type BuyerConnection,
} from "@antseed/buyer-core";
import type { MuxConfig } from "./config.js";
import { buildSellerPeerView } from "./seller-peer-view.js";
import { userDir } from "./identity.js";

export interface SpendEvent {
  userId: string;
  peerId: string;
  requestId?: string;
  usdcAmount?: bigint;
  cumulativeAmount?: bigint;
  ts: number;
}

export class UserSession extends EventEmitter {
  readonly userId: string;
  readonly identity: Identity;
  lastActivity = Date.now();

  private _cm: ConnectionManager | null = null;
  private _conn: PeerConnection | null = null;
  private _proxyMux: ProxyMux | null = null;
  private _paymentMux: PaymentMux | null = null;
  private _keepalive: KeepaliveManager | null = null;
  private _handler: BuyerRequestHandler | null = null;
  private _deposits: DepositsClient | null = null;
  private _negotiator: BuyerPaymentNegotiator | null = null;
  private _cfgSnapshot: MuxConfig | null = null;
  private _opening: Promise<void> | null = null;

  private _cfg: MuxConfig | null = null;

  constructor(userId: string, identity: Identity, cfg?: MuxConfig) {
    super();
    this.userId = userId;
    this.identity = identity;
    this._cfg = cfg ?? null;
  }

  get peerId(): string { return this.identity.peerId; }
  get evmAddress(): string { return this.identity.wallet.address; }
  get isOpen(): boolean {
    return !!this._conn &&
      (this._conn.state === ConnectionState.Open ||
       this._conn.state === ConnectionState.Authenticated);
  }

  /** Идемпотентный старт: соединение + платёжный стек. */
  async ensureOpen(cfg: MuxConfig): Promise<void> {
    if (this.isOpen) { this.lastActivity = Date.now(); return; }
    if (this._opening) return this._opening;
    this._opening = this._open(cfg).finally(() => { this._opening = null; });
    return this._opening;
  }

  private async _open(cfg: MuxConfig): Promise<void> {
    const identity = this.identity;
    const sellerPeer = buildSellerPeerView(cfg) as unknown as BuyerPeerView;

    // ── транспорт ──
    const cm = await ConnectionManager.init(undefined, { requireSecureTransport: true });
    cm.setLocalIdentity(identity);
    const [host, portS] = cfg.sellerPublicAddress.split(":");
    cm.registerPeerEndpoint(cfg.sellerPeerId as never, { host, port: Number(portS) });
    this._cm = cm;

    const conn = cm.createConnection({
      remotePeerId: cfg.sellerPeerId as never,
      isInitiator: true,
      remoteCapabilities: cfg.sellerCapabilities,
    });
    this._conn = conn;

    const proxyMux = new ProxyMux(conn, { maxUploadBodyBytes: cfg.maxUploadBodyBytes });
    this._proxyMux = proxyMux;

    // ── платёжный стек (зеркало node.js:1342-1382) ──
    const paymentsDir = join(userDir(cfg.dataDir, identity.peerId), "payments");
    const channelStore = new ChannelStore(paymentsDir);
    const bpm = new BuyerPaymentManager(identity, {
      rpcUrl: cfg.rpcUrl,
      fallbackRpcUrls: cfg.fallbackRpcUrls,
      depositsContractAddress: cfg.depositsAddress,
      channelsContractAddress: cfg.channelsAddress,
      usdcAddress: cfg.usdcAddress,
      identityRegistryAddress: cfg.identityRegistryAddress,
      chainId: cfg.evmChainId,
      defaultAuthDurationSecs: cfg.defaultAuthDurationSecs,
      maxPerRequestUsdc: cfg.maxPerRequestUsdc,
      maxReserveAmountUsdc: cfg.maxReserveAmountUsdc,
      dataDir: paymentsDir,
    }, channelStore, undefined);
    bpm.setSpendListener((ev: any) => {
      this.emit("spend", {
        userId: this.userId, peerId: identity.peerId,
        requestId: ev?.requestId, usdcAmount: ev?.amount,
        cumulativeAmount: ev?.cumulativeAmount, ts: Date.now(),
      } satisfies SpendEvent);
    });

    this._deposits = new DepositsClient({
      rpcUrl: cfg.rpcUrl,
      fallbackRpcUrls: cfg.fallbackRpcUrls,
      contractAddress: cfg.depositsAddress,
      usdcAddress: cfg.usdcAddress,
      evmChainId: cfg.evmChainId,
    });
    const channelsClient = new ChannelsClient({
      rpcUrl: cfg.rpcUrl,
      fallbackRpcUrls: cfg.fallbackRpcUrls,
      contractAddress: cfg.channelsAddress,
      evmChainId: cfg.evmChainId,
    });

    const negotiator = new BuyerPaymentNegotiator(
      identity, bpm, this._deposits, channelsClient, channelStore,
      { isChainReachable: () => true, onChainReadFailure: () => {} },
      this, /* emitter */ undefined, /* sellerAddressResolver: peerId=address */
      null, /* freeUsageManager */
    );
    this._negotiator = negotiator;
    this._cfgSnapshot = cfg;

    // ── frame dispatch (зеркало _wireConnection) ──
    const decoder = new FrameDecoder();
    conn.on("message", (data: Uint8Array) => {
      let frames;
      try { frames = decoder.feed(data); }
      catch (err) { conn.fail(err instanceof Error ? err : new Error(String(err))); return; }
      for (const frame of frames) {
        if (frame.type === MessageType.Ping) {
          if (this.isOpen) conn.send(encodeFrame({
            type: MessageType.Pong, messageId: frame.messageId,
            payload: buildPongPayload(frame.payload),
          }));
          continue;
        }
        if (frame.type === MessageType.Pong) { this._keepalive?.handlePong(frame.payload); continue; }
        if (PaymentMux.isPaymentMessage(frame.type)) {
          void this._paymentMux?.handleFrame(frame).catch(() => {});
        } else {
          void proxyMux.handleFrame(frame).catch(() => {});
        }
      }
    });
    conn.on("stateChange", (s: ConnectionState) => {
      if (s === ConnectionState.Closed || s === ConnectionState.Failed) {
        this.emit("closed", this.userId);
      }
    });

    // ── request handler (зеркало node.js:1383-1397) ──
    this._handler = new BuyerRequestHandler({
      requestTimeoutMs: cfg.requestTimeoutMs,
      maxStreamDurationMs: cfg.maxStreamDurationMs,
    }, {
      localPeerId: identity.peerId,
      negotiator,
      freeUsageManager: null,
      verificationStorage: null,   // синтетические ре-пробы выключены (доктрина)
      verificationSampler: null,
      getConnection: async () => conn as unknown as BuyerConnection,
      getMux: () => proxyMux,
      // verification-стораджа нет → shouldExpectResponseAuth гасит вызовы;
      // стаб нужен только чтобы не падать на безусловном getVerificationMux.
      getVerificationMux: () => ({
        waitForResponseAuth: () => new Promise(() => {}),
      }) as never,
      registerPaymentMux: (_peerId: string, mux: PaymentMux) => { this._paymentMux = mux; },
    });

    // ── ждём открытия ──
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("connect timeout 30s")), 30_000);
      const onState = (s: ConnectionState) => {
        if (s === ConnectionState.Open || s === ConnectionState.Authenticated) {
          conn.off("stateChange", onState); clearTimeout(timer); resolve();
        } else if (s === ConnectionState.Failed || s === ConnectionState.Closed) {
          conn.off("stateChange", onState); clearTimeout(timer);
          reject(new Error(`connection to seller failed (${s})`));
        }
      };
      conn.on("stateChange", onState);
    });

    // keepalive после открытия (initiator пингует)
    this._keepalive = new KeepaliveManager({
      sendPing: (payload: Uint8Array) => {
        if (this.isOpen) conn.send(encodeFrame({
          type: MessageType.Ping, messageId: 0, payload,
        }));
      },
      onDead: () => { this.emit("closed", this.userId); conn.close(); },
    });
    this._keepalive.start();
    this.lastActivity = Date.now();
  }

  /** Отправить HTTP-запрос через канал. Коллбэки = стриминг. */
  async sendRequest(
    cfg: MuxConfig,
    req: SerializedHttpRequest,
    callbacks?: {
      onResponseStart?: (r: SerializedHttpResponse, meta: { streaming: boolean }) => void;
      onChunk?: (c: SerializedHttpResponseChunk) => void;
    },
    signal?: AbortSignal,
  ): Promise<SerializedHttpResponse> {
    await this.ensureOpen(cfg);
    if (!this._handler) throw new Error("session not started");
    this.lastActivity = Date.now();
    const sellerPeer = buildSellerPeerView(cfg) as unknown as BuyerPeerView;
    return this._handler.sendRequest(sellerPeer, req, callbacks, { signal, pinned: true });
  }

  /** On-chain баланс депозита юзера (available/reserved).
   *  Работает и на холодной сессии: deposits-клиент не требует коннекта к селлеру. */
  async balance(): Promise<{ available: bigint; reserved: bigint } | null> {
    if (!this._deposits && this._cfg) {
      this._deposits = new DepositsClient({
        rpcUrl: this._cfg.rpcUrl,
        fallbackRpcUrls: this._cfg.fallbackRpcUrls,
        contractAddress: this._cfg.depositsAddress,
        usdcAddress: this._cfg.usdcAddress,
        evmChainId: this._cfg.evmChainId,
      });
    }
    if (!this._deposits) return null;
    try {
      const b = await this._deposits.getBuyerBalance(this.evmAddress);
      return { available: b.available, reserved: b.reserved };
    } catch (e: any) {
      console.error("[mux] balance() fail:", String(e?.shortMessage || e?.message || e).slice(0, 200));
      return null;
    }
  }

  /** Cooperative close: сеттлим канал с селлером и закрываем его (0x59/0x5A).
   *  Освобождает reserved. Требует живого коннекта — открывает при необходимости. */
  async closeChannel(cfg: MuxConfig): Promise<{ status: string; finalAmount?: string }> {
    await this.ensureOpen(cfg);
    if (!this._negotiator || !this._conn) throw new Error("no payment stack");
    const res: any = await (this._negotiator as any).requestChannelClose(cfg.sellerPeerId, this._conn, { includeAuth: true });
    return { status: res?.status ?? "unknown", finalAmount: res?.finalAmount?.toString?.() };
  }

  /** Глубокий сон: закрыть TCP, канал и стейт на диске остаются. */
  async hibernate(): Promise<void> {
    this._keepalive?.stop();
    this._keepalive = null;
    try { this._conn?.close(); } catch {}
    this._conn = null; this._cm = null; this._proxyMux = null;
    this._paymentMux = null; this._handler = null;
  }

  async destroy(): Promise<void> { await this.hibernate(); this.removeAllListeners(); }
}
