/** Anything the codecs will read bytes from. */
export type ByteSource = AsyncIterable<Uint8Array> | Iterable<Uint8Array>;

export type RequestEnvelope = {
  url: string;
  method: string;
  headers: [string, string][];
};

export type ResponseEnvelope = {
  status: number;
  statusText: string;
  headers: [string, string][];
};

export type DecodedRequest = {
  envelope: RequestEnvelope;
  body: AsyncIterable<Uint8Array>;
};

export type DecodedResponse = {
  envelope: ResponseEnvelope;
  body: AsyncIterable<Uint8Array>;
};

/** Extra context a codec may need that the envelope does not carry. */
export type ResponseCodecOptions = {
  /**
   * Method of the request this response answers. Required by HTTP/1.1: a
   * response to HEAD carries framing headers but no body, and no parser can
   * know that from the response bytes alone.
   */
  method: string;
};

/**
 * One wire format. Requests and responses are separate operations because
 * HTTP/1.1 serialises them differently — a codec cannot be generic over the
 * envelope the way the JSON format was.
 */
export interface MessageCodec {
  readonly name: string;

  /**
   * True if a message in this format may begin with `byte`. Used by the
   * sniffing codec to dispatch without a negotiation handshake. Implementations
   * must be mutually exclusive with every other codec they are paired with.
   */
  sniff(byte: number): boolean;

  encodeRequest(env: RequestEnvelope, body?: ByteSource): AsyncGenerator<Uint8Array>;
  encodeResponse(
    env: ResponseEnvelope,
    body?: ByteSource,
    options?: ResponseCodecOptions,
  ): AsyncGenerator<Uint8Array>;

  decodeRequest(input: ByteSource): Promise<DecodedRequest>;
  decodeResponse(input: ByteSource, options: ResponseCodecOptions): Promise<DecodedResponse>;
}
