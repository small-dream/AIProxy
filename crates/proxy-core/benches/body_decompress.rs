//! Benchmarks for the proxy's own body-decompression entry point
//! (`http_io::decode_body_bytes`). The implementation is included verbatim
//! below so the numbers cover the crate's real decode path rather than a bare
//! flate2 decoder.

use std::hint::black_box;
use std::io::{Cursor, Read, Write};

use brotli::Decompressor;
use criterion::{criterion_group, criterion_main, Criterion};
use flate2::read::{DeflateDecoder, GzDecoder, ZlibDecoder};
use flate2::write::GzEncoder;
use flate2::Compression;

// Mirror of the crate-internal constant the included decode code expects.
const BROTLI_BUFFER_SIZE: usize = 4096;

include!("../src/http_io/body_decode.rs");

fn generate_gzip_body(raw_size: usize) -> Vec<u8> {
    let raw = "A".repeat(raw_size);
    let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
    encoder.write_all(raw.as_bytes()).unwrap();
    encoder.finish().unwrap()
}

fn bench_gzip_decompress(c: &mut Criterion) {
    let mut group = c.benchmark_group("body_decompress");

    for size in [1024, 1024 * 1024, 10 * 1024 * 1024] {
        let compressed = generate_gzip_body(size);
        let label = format!("gzip_{}kb", size / 1024);

        group.bench_function(&label, |b| {
            b.iter(|| {
                let decoded = decode_body_bytes(black_box(&compressed[..]), Some("gzip"));
                black_box(decoded)
            });
        });
    }

    group.finish();
}

criterion_group!(benches, bench_gzip_decompress);
criterion_main!(benches);
