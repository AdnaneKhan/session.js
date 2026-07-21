# Creating a group

`createGroup` generates the group address and first encryption keypair, stores
the group, sends a `NEW` invite to every member (including yourself, for
multi-device), and starts polling the group's swarm.

```ts
const group = await groups.createGroup({
	name: "My group",
	members: [friendSessionId, otherSessionId], // ours is added automatically
	expirationTimer: 0,                          // seconds; deleteAfterSend, 0 = off
});

console.log(group.publicKey); // 05… group address (66 chars)
console.log(group.admins);    // [ourSessionId] — the creator is the only admin
```

## What happens on the wire

1. A random ed25519 keypair is generated; its public key is converted to
   x25519 and `05`-prefixed → the **group address**. The ed25519 secret is
   discarded (a legacy group cannot sign).
2. A fresh x25519 **encryption keypair** is generated (stored unprefixed).
3. One `NEW` control message is sent **1:1 to each member's swarm** (namespace
   0), sealed to that member's identity key. The group encryption keypair
   travels **plaintext inside the sealed box** — confidentiality is the outer
   seal.
4. The creator stores the group + keypair, starts polling the group swarm
   (namespace −10), and emits `groupCreated`.

```ts
groups.on("groupCreated", (state) => {
	// state: { publicKey, name, members, admins, zombies, active,
	//          lastJoinedTimestamp, formationTimestamp, expirationTimer }
});
```

## Rules

- `name` must be non-empty.
- Member IDs must be valid `05…` Session IDs.
- At most **100 members** (the official `CLOSED_GROUP_SIZE_LIMIT`).
- You are always a member and the (first) admin.

!!! note "Disappearing messages"
    Closed groups support `deleteAfterSend` only. `deleteAfterRead` is rejected
    for groups by the protocol. Set `expirationTimer` (seconds) at creation; it
    is applied to the chat messages you send.
