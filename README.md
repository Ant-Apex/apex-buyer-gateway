# Apex Ant — Buyer Gateway

Hosted multi-user buyer stack for the [AntSeed](https://antseed.com) P2P network. Powers the hosted path of [apex-ant.net](https://apex-ant.net): connect wallet → generated buyer identity → USDC deposit → `apx_` API key → OpenAI-compatible inference.

Runs inside a TEE (Phala CVM). The image digest is attested — see the trust page.

## Components

- **`mux/`** — multi-user buyer mux. Holds hot AntSeed buyer sessions for many users against a pinned seller, one payment channel per user, cooperative channel close. Built on `@antseed/*` libraries.
- **`gw/`** — API gateway. SIWE-style wallet auth, bcrypt-hashed `apx_` keys, OpenAI/Venice-shaped endpoints (`/api/v1/chat/completions`, `/image/generate`, `/image/edit`, `/models`, `/balance`), rate limits, usage metering.

## Config

Everything is env-driven; no secrets in the repo. See `mux/src/config.ts` for the full list.

## Security model

User buyer keys are stored AES-256-GCM encrypted; key material comes from the environment only. In production the whole stack runs in a TEE and secrets are KMS-gated to the attested image digest.

## License

MIT
