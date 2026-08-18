/**
 * Raised for any byte sequence this codec refuses to interpret. Every case is
 * a refusal to guess: HTTP/1.1 parsers that guess are how request smuggling
 * works.
 */
export class HttpParseError extends Error {
  override readonly name = "HttpParseError";
}
