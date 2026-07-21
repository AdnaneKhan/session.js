# Group messaging

## Sending

```ts
const { messageHash, timestamp } = await groups.sendMessage(
	group.publicKey,
	"hello everyone",
	// { expireTimer: 3600 }  // optional per-message override (deleteAfterSend)
);
```

The message is sealed to the group's **latest** encryption key, wrapped in a
`CLOSED_GROUP_MESSAGE` envelope (source = group address), and stored to the
group's swarm at **namespace −10** with a `GroupContext`
(`id = utf8("05…hex")`, `type = DELIVER`).

If the group has a disappearing-message timer, it is applied automatically
(`deleteAfterSend`); you can override it per message with `expireTimer`.

`sendMessage` throws if the group is unknown (`GroupNotFoundError`), inactive —
you left or were removed (`GroupInactiveError`) — or has no encryption keypair
(`InvalidKeypairError`).

## Receiving

Group chat arrives via the `groupMessage` event (see
[Joining & receiving](joining.md)):

```ts
groups.on("groupMessage", (m) => {
	// m.type === "group"
	console.log(m.groupId, m.from, m.text, m.timestamp);
});
```

Only messages for groups you are an **active** member of are surfaced; unknown
or left groups are dropped.

## Attachments & quotes

v1 group messaging covers text. Attachments / quotes / reactions inside groups
follow the same `VisibleMessage` plumbing as 1:1 messages and are on the
roadmap; the 1:1 APIs are documented under
[Files and attachments](../files-and-attachments.md) and
[Reactions](../reactions.md).
