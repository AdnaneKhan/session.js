// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Public surface of @session.js/calls. See IMPLEMENTATION.MD §4.3 for the
// normative API shape and COPYING.provenance for per-file licensing.
//
// The consumer quick path:
//
//   import { CallManager, PeerConnectionManager } from "@session.js/calls";
//   const calls = new CallManager(session, { logger: myLogger });
//   calls.on("incoming", (call) => void call.accept());
//   const call = await calls.call(peerSessionId);
//
// (PeerConnectionManager is the default MediaEngine — constructed
// internally by CallManager; exported for advanced wiring and tests.)

// Normative API types + wire constants (§4.3 / §3.1)
export * from "./types.js";
// Error taxonomy (P6-T3)
export * from "./errors.js";
// Freshness / TURN / batching / redaction policies
export * from "./policy.js";
// FSM table + pure transition function
export * from "./fsm/state-machine.js";
// Call supervisor (FSM execution, inbound gating, timers) + call context
export * from "./supervisor.js";
// Signaling transport: SessionSignaling + TrickleIceSender
export * from "./signaling.js";
// Public Call handle implementation
export * from "./call.js";
// CallManager — the public entry point
export * from "./call-manager.js";

// Media plane (public: advanced consumers can wire their own pipelines;
// CallManager uses PeerConnectionManager by default).
export * from "./media/peer-connection.js";
export * from "./media/audio-bridge.js";
export * from "./media/codec.js";
export * from "./media/dsp.js";
export * from "./media/sdp.js";
