import assert from "node:assert/strict";
import test from "node:test";
import { redactSensitiveText } from "./src/context.ts";

test("remote context redacts common credentials and private keys", () => {
  const source = `api_key=super-secret-value
password: hunter2
AWS_SECRET_ACCESS_KEY=aws-secret
Authorization: Bearer bearer-value
sk-abcdefghijklmnop
-----BEGIN OPENSSH PRIVATE KEY-----
private material
-----END OPENSSH PRIVATE KEY-----`;
  const redacted = redactSensitiveText(source);
  assert.doesNotMatch(
    redacted,
    /super-secret-value|hunter2|aws-secret|bearer-value|sk-abcdefghijklmnop|private material/,
  );
  assert.match(redacted, /REDACTED/);
});
