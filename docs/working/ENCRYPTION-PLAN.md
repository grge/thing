# Encryption: the implementation plan

**Status: a plan, not built.** Stage 10. It records the decisions taken so a
session can start from them rather than re-deriving them, and the seams found by
reading the code.

Design: §6 for what encryption is and what it does not do,
`../design/ROOT-IN-CLEAR.md` for the root exemption,
`../design/CAPABILITIES.md` for the nonce and the `r=` link field.

---

## Decisions taken

**Cipher: XChaCha20-Poly1305, via `@noble/ciphers`. Subkeys via HKDF-SHA256 from
`@noble/hashes`.**

Not WebCrypto. `platform.d.ts` declares only what *both* runtimes genuinely
provide, and its own comment warns that widening it to fix one import silently
loses that property everywhere. `sign.ts` already set the precedent — it uses
`@noble/ed25519` because platform support arrived late enough that a fallback
was not optional. The same reasoning applies here, and XChaCha's 24-byte nonce
removes any question of nonce-size pressure.

`@noble/hashes` is already a dependency. `@noble/ciphers` is new.

**Blobs are randomised, not deterministic.**

§6 offers deriving a blob's key and nonce from its plaintext hash, which
restores §2.4's deduplication. Taken deliberately the other way:

- **What deterministic costs** is a confirm-a-known-file attack by someone
  *without* the reading key — a hub operator who guesses a candidate can encrypt
  it and compare hashes to learn whether the space holds that exact file. Small,
  but unbounded in time and aimed at exactly the party a public server exposes
  you to.
- **What randomised costs** is duplicate storage, and only when the same bytes
  are added twice within one space. Blobs are stored at `blobs/<hash>`, so
  deduplication today is emergent rather than structural — nothing depends on
  it, and it never crossed spaces anyway. Sync is unaffected: the hash is the
  address, so two ciphertexts of one plaintext are simply two blobs.

The trade is *some disk on a machine you own* against *a standing disclosure to
whoever hosts you*. §2.4's dedup promise becomes false for encrypted spaces and
should say so.

**Root-targeted events are not encrypted** (`../design/ROOT-IN-CLEAR.md`), so a
peer without the reading key still folds the root and evaluates membership.
`:name` in clear is the accepted cost.

**Nonce: `(writer, point, seq)`.** §6 said `(writer, seq)` and flagged that the
pair is unique only while one identity has one chain; append points broke that.
The triple is what already keys a chain, so uniqueness is structural rather than
assumed.

## The seams, from reading the code

Smaller than expected. Every path funnels through one or three places:

| | where | count |
| --- | --- | --- |
| value encrypted | `Space.write` → `writer.write(target, attr, value, wall)` | 1 |
| value decrypted | `rule.codec.decode(e.value)` | 3 — `fold.ts:110`, `incremental.ts:213`, `incremental.ts:248` |
| blob encrypted | `Space.putBlob` | 1 |
| blob decrypted | `Space.getBlob` | 1 |

The envelope needs no change: `value` is already `Uint8Array` and the signature
covers the preimage, so signing over ciphertext works as-is.

**The root exemption lands where the code already splits.** Both folds partition
on `isRoot(e.target)` before anything else — `fold.ts:158` and
`incremental.ts:116` — so "root events are cleartext" is a property of an
existing partition rather than a special case threaded through the codec.

## Build order

1. **`core/cipher.ts`** — derive subkeys from a reading key, encrypt and decrypt
   a value given `(writer, point, seq)`, encrypt and decrypt a blob with a
   random nonce carried alongside the ciphertext. Pure, testable without a
   space.
2. **`Space` takes an optional reading key.** Encrypt in `write` and `putBlob`;
   decrypt at the three decode sites and in `getBlob`. Root-targeted events skip
   it in both directions.
3. **The keyring holds reading keys**, beside writing keys. A space may have one
   or not, and not having one is ordinary (§6.1).
4. **`r=` in the share link** — the field `CAPABILITIES.md` left for this stage.
   A link with `k` alone replicates; with `r` reads.
5. **The UI.** A keyless peer folds structure and no bodies, so every object
   shows `bodyRuleMissing` — correct, and the object header must say *encrypted,
   no reading key* rather than looking broken.

## What to check while building

- **An unencrypted space and an encrypted one must fold identically** given the
  key. The exemption is about what is encrypted, never about what is admitted.
- **A ciphertext-only peer must still store, serve, verify and relay** — §6.1's
  table is the specification, and the hosting tests already exercise the path.
- **The conformance suite is the place** for "a peer without the key can do X",
  since it runs against all three stores.
- **Deterministic ciphertext must not creep back in** by accident. A blob
  encrypted twice must produce two different ciphertexts; that is a test, not a
  comment.
- **`:kind` is encrypted**, so a keyless peer cannot pick a body rule at all
  (§6.1). That is deliberate and the UI must not treat it as corruption.

## What this does not do

§6.3, unchanged and worth re-reading before building: it is not partial, not
revocable, does not hide structure, does not hide identity, and does not protect
against a reader. None of that is fixed here.

**"Does not hide structure" is the big one**, and `LEARNINGS.md` §20 sizes it:
a host learns how many objects exist, how often each changed, which are files
and which folders, when, in what order, by whom, and how large every blob is.
That falls out of events being the unit of replication and is not fixable with a
cipher. Build accordingly, and do not let the UI imply more privacy than this.

**And it does not bound unadmitted writes** (OPEN.md 8a) — the root exemption
makes the check *possible* for a keyless peer, but membership is still
time-dependent (§7.2.3), so a store must not refuse on arrival. The likely shape
is *store it, decline to relay it*, and it is not part of this stage.
