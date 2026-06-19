use std::hint::black_box;

use criterion::{criterion_group, criterion_main, Criterion};
use flate2::read::GzDecoder;
use flate2::write::GzEncoder;
use flate2::Compression;
use std::io::{Read, Write};

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
                let mut decoder = GzDecoder::new(black_box(&compressed[..]));
                let mut decoded = Vec::with_capacity(size);
                let _ = decoder.read_to_end(&mut decoded);
            });
        });
    }

    group.finish();
}

criterion_group!(benches, bench_gzip_decompress);
criterion_main!(benches);
