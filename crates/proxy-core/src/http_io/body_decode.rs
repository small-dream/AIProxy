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
    let mut decoder = DeflateDecoder::new(Cursor::new(input));
    let mut output = Vec::new();
    match decoder.read_to_end(&mut output) {
        Ok(_) => Some(output),
        Err(_) => None,
    }
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
            "gzip" | "x-gzip" => {
                let mut decoder = GzDecoder::new(Cursor::new(decoded));
                let mut output = Vec::new();
                decoder.read_to_end(&mut output).ok()?;
                output
            }
            "deflate" => {
                // Some servers send raw deflate (RFC 1951) even though the
                // "deflate" Content-Encoding is nominally zlib-wrapped
                // (RFC 1950). Try zlib first, then fall back to raw deflate.
                let mut output = Vec::new();
                let mut zlib_decoder = ZlibDecoder::new(Cursor::new(&decoded));
                if zlib_decoder.read_to_end(&mut output).is_ok() {
                    output
                } else {
                    // Raw deflate (no zlib header) via flate2's Decompress.
                    raw_deflate_decode(&decoded)?
                }
            }
            "br" => {
                let mut decoder = Decompressor::new(Cursor::new(decoded), BROTLI_BUFFER_SIZE);
                let mut output = Vec::new();
                decoder.read_to_end(&mut output).ok()?;
                output
            }
            _ => return None,
        };
    }

    Some(decoded)
}
