// Written fresh from the published SessionProtos.proto field facts. MIT-licensable for upstream contribution.
import * as Constants from "@session.js/consts";
import { SignalService } from "@session.js/types/signal-bindings";
import { SessionValidationError, SessionValidationErrorCode } from "@session.js/errors";
import { ContentMessage, type MessageParams } from "../signal-message";

const UUID_V4_REGEX =
	/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface CallMessageParams extends MessageParams {
	type: SignalService.CallMessage.Type;
	/** Call id: stringified UUIDv4 */
	uuid: string;
	/** SDP offer (OFFER), SDP answer (ANSWER) or ICE candidates (ICE_CANDIDATES) */
	sdps?: string[];
	/** Parallel array to `sdps`, required for ICE_CANDIDATES */
	sdpMLineIndexes?: number[];
	/** Parallel array to `sdps`, required for ICE_CANDIDATES */
	sdpMids?: string[];
}

export class CallMessage extends ContentMessage {
	public readonly type: SignalService.CallMessage.Type;
	public readonly uuid: string;
	public readonly sdps?: string[];
	public readonly sdpMLineIndexes?: number[];
	public readonly sdpMids?: string[];

	constructor(params: CallMessageParams) {
		super({ timestamp: params.timestamp, identifier: params.identifier });
		if (!UUID_V4_REGEX.test(params.uuid)) {
			throw new SessionValidationError({
				code: SessionValidationErrorCode.InvalidOptions,
				message: "CallMessage uuid must be a stringified UUIDv4",
			});
		}
		if (params.type === SignalService.CallMessage.Type.ICE_CANDIDATES) {
			if (
				!params.sdps?.length ||
				!params.sdpMLineIndexes?.length ||
				!params.sdpMids?.length ||
				params.sdps.length !== params.sdpMLineIndexes.length ||
				params.sdps.length !== params.sdpMids.length
			) {
				throw new SessionValidationError({
					code: SessionValidationErrorCode.InvalidOptions,
					message:
						"ICE_CANDIDATES CallMessage requires non-empty sdps, sdpMLineIndexes and sdpMids of equal length",
				});
			}
		}
		if (
			(params.type === SignalService.CallMessage.Type.OFFER ||
				params.type === SignalService.CallMessage.Type.ANSWER) &&
			!params.sdps?.length
		) {
			throw new SessionValidationError({
				code: SessionValidationErrorCode.InvalidOptions,
				message:
					"OFFER and ANSWER CallMessages require a non-empty sdps array with the local SDP",
			});
		}
		this.type = params.type;
		this.uuid = params.uuid;
		this.sdps = params.sdps;
		this.sdpMLineIndexes = params.sdpMLineIndexes;
		this.sdpMids = params.sdpMids;
	}

	public ttl(): number {
		return Constants.TTL_DEFAULT.CALL_MESSAGE;
	}

	public contentProto(): SignalService.Content {
		return new SignalService.Content({
			callMessage: {
				type: this.type,
				uuid: this.uuid,
				...(this.sdps?.length && { sdps: this.sdps }),
				...(this.sdpMLineIndexes?.length && { sdpMLineIndexes: this.sdpMLineIndexes }),
				...(this.sdpMids?.length && { sdpMids: this.sdpMids }),
			},
		});
	}
}
