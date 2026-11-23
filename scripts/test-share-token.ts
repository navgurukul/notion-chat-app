import assert from "node:assert/strict";
import { generateShareToken, hashShareToken } from "../src/lib/chat/share/share-token";

const token = generateShareToken();
const secondToken = generateShareToken();
const hash = hashShareToken(token);

assert.equal(token.length, 43, "generated tokens should encode 32 bytes as 43 characters");
assert.match(token, /^[A-Za-z0-9_-]+$/, "generated tokens should use URL-safe characters");
assert.match(hash, /^[a-f0-9]{64}$/, "SHA-256 hashes should be 64 lowercase hex characters");
assert.notEqual(token, secondToken, "generated tokens should be unique");
assert.equal(hashShareToken(token), hash, "token hash should be deterministic");
assert.notEqual(hash, token, "stored hash should differ from the raw token");

console.log("Share token checks passed");
