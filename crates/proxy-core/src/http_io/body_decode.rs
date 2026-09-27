// Body-decompression implementation, shared verbatim between the crate and
// its benchmark.
//
// This file is NOT a module: it is pulled in via `include!` from
// `src/http_io.rs` (the production path) and from
// `benches/body_decompress.rs` (so the benchmark exercises the crate's own
// decode entry point instead of re-testing flate2). It therefore relies on
// the including scope for its imports (`Cursor`, `Read`, `GzDecoder`,
// `ZlibDecoder`, `DeflateDecoder`, `Decompressor`) and for the
// `BROTLI_BUFFER_SIZE` constant.

/// Decode a raw DEFLATE stream (RFC 1951, no zlib wrapper).
///
/// Uses flate2's streaming `DeflateDecoder` (the `Read` API). This consumes
/// the input incrementally and is correct for arbitrary payload sizes and
/// compression ratios. The previous manual `Decompress` loop re-fed the full
/// input slice on every iteration, which corrupted output once the initial
/// spare capacity was exceeded (highly-compressible payloads).
fn raw_deflate_decode(input: &[u8]) -> Option<Vec<u8>> {
    read_decoded_bounded(
        DeflateDecoder::new(Cursor::new(input)),
        MAX_DECOMPRESSED_BODY_BYTES,
    )
}

/// Upper bound on the decompressed output of one [`decode_body_bytes`] call.
///
/// The compressed input is already capped at `MAX_CAPTURED_BODY_BYTES` (20 MiB)
/// by the capture path, but decompression is not size-preserving: a crafted or
/// hostile response can expand by ~1000x, so an unbounded `read_to_end` turns a
/// bounded capture into gigabytes of resident memory (zip bomb). 64 MiB leaves
/// every realistic payload well inside the limit (the decompress benchmark
/// covers 10 MiB) while bounding the worst case.
const MAX_DECOMPRESSED_BODY_BYTES: usize = 64 * 1024 * 1024;

/// Read a decoder to EOF, returning `None` when the output would exceed `limit`.
///
/// `None` means "cannot decode", the same contract as an unsupported or corrupt
/// encoding: callers fall back to the raw (still capture-bounded) wire bytes.
/// A partial decode is never returned, so a truncated expansion can never be
/// mistaken for — or written back as — the whole body.
fn read_decoded_bounded<R: Read>(reader: R, limit: usize) -> Option<Vec<u8>> {
    let mut output = Vec::new();
    // Take one byte past the limit so a body of exactly `limit` bytes still
    // counts as decoded; the extra byte is what makes the overflow observable.
    let mut bounded = reader.take(limit as u64 + 1);
    if bounded.read_to_end(&mut output).is_err() {
        return None;
    }
    if output.len() > limit {
        tracing::warn!(
            event = "body_decode_output_limit_exceeded",
            limit,
            "body_decode_output_limit_exceeded"
        );
        return None;
    }
    Some(output)
}

pub(crate) fn decode_body_bytes(body: &[u8], content_encoding: Option<&str>) -> Option<Vec<u8>> {
    let encodings: Vec<String> = content_encoding?
        .split(',')
        .map(|encoding| encoding.trim().to_ascii_lowercase())
        .filter(|encoding| !encoding.is_empty() && encoding != "identity")
        .collect();
    if encodings.is_empty() {
        return None;
    }

    let mut decoded = body.to_vec();

    for encoding in encodings.iter().rev() {
        decoded = match encoding.as_str() {
            "gzip" | "x-gzip" => read_decoded_bounded(
                GzDecoder::new(Cursor::new(decoded)),
                MAX_DECOMPRESSED_BODY_BYTES,
            )?,
            "deflate" => {
                // Some servers send raw deflate (RFC 1951) even though the
                // "deflate" Content-Encoding is nominally zlib-wrapped
                // (RFC 1950). Try zlib first, then fall back to raw deflate.
                // An over-limit expansion fails both attempts (the raw-deflate
                // parse of a zlib stream errors out), so it lands on the
                // "cannot decode" path rather than a truncated body.
                match read_decoded_bounded(
                    ZlibDecoder::new(Cursor::new(&decoded)),
                    MAX_DECOMPRESSED_BODY_BYTES,
                ) {
                    Some(output) => output,
                    // Raw deflate (no zlib header).
                    None => raw_deflate_decode(&decoded)?,
                }
            }
            "br" => read_decoded_bounded(
                Decompressor::new(Cursor::new(decoded), BROTLI_BUFFER_SIZE),
                MAX_DECOMPRESSED_BODY_BYTES,
            )?,
            _ => return None,
        };
    }

    Some(decoded)
}
