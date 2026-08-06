export function redactSensitiveText(text: string) {
  return text
    .replace(/(https?:\/\/[^:/\s]+:)[^@\s]+@/gi, "$1[REDACTED]@")
    .replace(
      /-----BEGIN [^-]+ PRIVATE KEY-----[\s\S]*?-----END [^-]+ PRIVATE KEY-----/g,
      "[REDACTED PRIVATE KEY]",
    )
    .replace(
      /\b([a-z0-9_-]*(?:api[_-]?key|token|password|passwd|secret)[a-z0-9_-]*)\b(\s*[:=]\s*)([^\s,;]+)/gi,
      "$1$2[REDACTED]",
    )
    .replace(
      /\bAuthorization\s*:\s*Bearer\s+\S+/gi,
      "Authorization: Bearer [REDACTED]",
    )
    .replace(
      /\b(sk-[A-Za-z0-9_-]{16,}|gh[opusr]_[A-Za-z0-9_-]{16,})\b/g,
      "[REDACTED TOKEN]",
    )
    .replace(
      /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
      "[REDACTED JWT]",
    );
}
