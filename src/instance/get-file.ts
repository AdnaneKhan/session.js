import type { Session } from "@/instance";
import type { MessageAttachment } from "@/messages";
import { decryptAttachment } from "@/attachments/decrypt";
import { type RequestDownloadAttachment, RequestType } from "@session.js/types/network/request";
import { SessionCryptoError, SessionCryptoErrorCode } from "@session.js/errors";

export async function getFile(this: Session, attachment: MessageAttachment): Promise<File> {
	if (attachment._key === undefined || attachment._digest === undefined) {
		throw new SessionCryptoError({
			code: SessionCryptoErrorCode.MessageDecryptionFailed,
			message: "Missing attachment key or digest",
		});
	}
	const fileBuffer = await this._request<Uint8Array, RequestDownloadAttachment>({
		type: RequestType.DownloadAttachment,
		body: { id: attachment.id },
	});
	const decryptedData = await decryptAttachment(fileBuffer, {
		size: attachment.size,
		key: attachment._key,
		digest: attachment._digest,
	});
	return new File([new Uint8Array(decryptedData)], attachment.name || "", {
		type: attachment.metadata.contentType || "application/octet-stream",
	});
}
