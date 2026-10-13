# ✨ Firefly Net
Browser simulator for decentralized, firefly-style flash synchronization of phones in a stadium, using only **flashlight + camera** (no network).

Each phone is a pulse-coupled oscillator (Mirollo–Strogatz): its phase rises to 1, it fires the torch, and whenever its camera sees a neighbor's flash it jumps its phase forward (`φ += ε·φ`, outside a refractory window). Modelled realities: torch on-latency, camera frame quantization (30/60 fps), processing delay, detection probability, camera range/FOV/aim, clock drift, scheduling jitter, false detections. Optional latency compensation (phone self-calibrates its own torch latency and "reaches back" by its known pipeline delay).

Platform latency ranges are **assumptions** for exploration, not measurements.

Run: `npx serve .` (or any static server) and open `index.html`. Headless: `node bench.mjs '{"n":3000}'`.
URL flags: `?autoplay&speed=2`.
