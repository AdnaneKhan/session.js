# Joining & receiving

You join a group automatically when you receive a valid `NEW` invite. There is
no explicit "accept" step — the official-client gates decide.

## Inbound `NEW` gates

An invite is accepted only if **all** hold (mirroring the official clients):

1. The sender is **approved** or is **us** — configure your policy with the
   `isSenderApproved` option (default: accept everyone):
   ```ts
   const groups = new GroupManager(session as never, {
   	isSenderApproved: (from) => myContacts.has(from),
   });
   ```
2. **We are listed in `members`.**
3. `name`, `publicKey`, `members`, `admins`, and `encryptionKeyPair` are all
   present.
4. The group address is a **legacy `05…`** address (not `03…`/v3).
5. **Dedupe** — if we already know the group and haven't left, the keypair is
   just appended (deduped by value); we don't re-join.

On success the group is stored, the keypair saved, polling started, and
`groupJoined` emitted:

```ts
groups.on("groupJoined", (state) => {
	console.log(`joined "${state.name}" (${state.publicKey})`);
});
```

The invite's envelope timestamp becomes the group's **watermark**
(`lastJoinedTimestamp`); later group updates older than it are dropped.

## Receiving group updates

Once joined, the `GroupManager` (via the core `GroupPoller`, namespace −10)
receives and applies group changes, emitting events:

| Event | When |
|---|---|
| `groupMessage` | A decrypted group chat message (`{ groupId, from, text, timestamp, … }`) |
| `groupChanged` | Name / members / keypair changed |
| `groupRemoved` | We were removed, an admin left (disband), or we left |

```ts
groups.on("groupMessage", (m) => {
	console.log(`<${m.from}> ${m.text}`);
});
groups.on("groupChanged", (state) => {
	console.log(`group ${state.publicKey} now: ${state.members.join(", ")}`);
});
groups.on("groupRemoved", ({ publicKey }) => {
	console.log(`group ${publicKey} gone`);
});
```

The **real author** of a group message is recovered from the sealed box
(`m.from`), never from the envelope (whose source is the group address). Your
own messages are dropped (you don't receive your own group traffic back).

## Undecryptable messages

If a group message arrives before you have the keypair that sealed it (e.g. a
rotation in flight), it is **cached, not dropped**, and retried automatically
once a new keypair arrives.
