import type { MessageCodec } from "../message.js";
import { decodeRequest, decodeResponse } from "./decode.js";
import { encodeRequest, encodeResponse, type ResolvedHttpCodecOptions } from "./encode.js";
import { isTokenChar } from "./headers.js";

export type HttpCodecOptions = {
  /**
   * Scheme used to rebuild an absolute url on decode. HTTP/1.1 origin-form
   * carries no scheme, so this is configuration, not wire data — a peer
   * configured `http` rebuilds an `https` url as `http`. Accepted cost of
   * decision 6; see ADR-0006.
   */
  scheme?: "http" | "https";
  /** Authority used when a url carries none. Also fills the mandatory Host header. */
  host?: string;
  /** Bound on the whole head section, start line included. Default 65536. */
  maxHeaderBytes?: number;
};

export function newHttpCodec(options: HttpCodecOptions = {}): MessageCodec {
  const opts: ResolvedHttpCodecOptions = {
    scheme: options.scheme ?? "http",
    host: options.host ?? "localhost",
    maxHeaderBytes: options.maxHeaderBytes ?? 65536,
  };
  return {
    name: "http/1.1",
    // A request starts with a method token, a response with "HTTP/1.1" — both
    // begin with a token character. "{" is not a token character, so this is
    // disjoint from jsonEnvelopeCodec by construction, not by convention.
    sniff: (byte: number): boolean => isTokenChar(byte),
    encodeRequest: (env, body) => encodeRequest(env, body, opts),
    encodeResponse: (env, body, o) => encodeResponse(env, body, opts, o?.method),
    decodeRequest: (input) => decodeRequest(input, opts),
    decodeResponse: (input, o) => decodeResponse(input, opts, o.method),
  };
}

export const httpCodec: MessageCodec = newHttpCodec();
export { HttpParseError } from "./errors.js";
