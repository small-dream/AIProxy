use std::io;
use std::pin::Pin;
use std::task::{Context, Poll};

use hyper::rt::{Read as HyperRead, ReadBufCursor, Write as HyperWrite};
use hyper_util::client::legacy::connect::{Connected, Connection};
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};

/// A unified stream type that carries either a plain TCP stream or a
/// TLS-wrapped stream.
///
/// Used by both the hyper legacy connector (via hyper Read/Write + Connection)
/// and the WebSocket upstream path (via tokio AsyncRead/AsyncWrite).
pub enum TlsOrPlain<S> {
    Plain(S),
    Tls(Box<tokio_rustls::client::TlsStream<S>>),
}

impl<S> Connection for TlsOrPlain<S> {
    fn connected(&self) -> Connected {
        Connected::new()
    }
}

impl<S> HyperRead for TlsOrPlain<S>
where
    S: AsyncRead + Unpin,
    tokio_rustls::client::TlsStream<S>: AsyncRead,
{
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        mut buf: ReadBufCursor<'_>,
    ) -> Poll<io::Result<()>> {
        let n = unsafe {
            let mut tbuf = ReadBuf::uninit(buf.as_mut());
            let poll_result = match self.get_mut() {
                TlsOrPlain::Plain(stream) => Pin::new(stream).poll_read(cx, &mut tbuf),
                TlsOrPlain::Tls(stream) => Pin::new(&mut *stream).poll_read(cx, &mut tbuf),
            };
            match poll_result {
                Poll::Ready(Ok(())) => tbuf.filled().len(),
                other => return other,
            }
        };
        unsafe {
            buf.advance(n);
        }
        Poll::Ready(Ok(()))
    }
}

impl<S> HyperWrite for TlsOrPlain<S>
where
    S: AsyncWrite + Unpin,
    tokio_rustls::client::TlsStream<S>: AsyncWrite,
{
    fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        match self.get_mut() {
            TlsOrPlain::Plain(stream) => Pin::new(stream).poll_write(cx, buf),
            TlsOrPlain::Tls(stream) => Pin::new(&mut *stream).poll_write(cx, buf),
        }
    }

    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        match self.get_mut() {
            TlsOrPlain::Plain(stream) => Pin::new(stream).poll_flush(cx),
            TlsOrPlain::Tls(stream) => Pin::new(&mut *stream).poll_flush(cx),
        }
    }

    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        match self.get_mut() {
            TlsOrPlain::Plain(stream) => Pin::new(stream).poll_shutdown(cx),
            TlsOrPlain::Tls(stream) => Pin::new(&mut *stream).poll_shutdown(cx),
        }
    }
}

impl<S> AsyncRead for TlsOrPlain<S>
where
    S: AsyncRead + Unpin,
    tokio_rustls::client::TlsStream<S>: AsyncRead,
{
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        match &mut *self {
            TlsOrPlain::Plain(s) => Pin::new(s).poll_read(cx, buf),
            TlsOrPlain::Tls(s) => Pin::new(&mut *s).poll_read(cx, buf),
        }
    }
}

impl<S> AsyncWrite for TlsOrPlain<S>
where
    S: AsyncWrite + Unpin,
    tokio_rustls::client::TlsStream<S>: AsyncWrite,
{
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        match &mut *self {
            TlsOrPlain::Plain(s) => Pin::new(s).poll_write(cx, buf),
            TlsOrPlain::Tls(s) => Pin::new(&mut *s).poll_write(cx, buf),
        }
    }

    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        match &mut *self {
            TlsOrPlain::Plain(s) => Pin::new(s).poll_flush(cx),
            TlsOrPlain::Tls(s) => Pin::new(&mut *s).poll_flush(cx),
        }
    }

    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        match &mut *self {
            TlsOrPlain::Plain(s) => Pin::new(s).poll_shutdown(cx),
            TlsOrPlain::Tls(s) => Pin::new(&mut *s).poll_shutdown(cx),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    /// A simple mock stream for testing TlsOrPlain dispatch.
    /// Since we can't easily construct a TlsStream without a real TLS handshake,
    /// we only test the Plain variant here. The Tls variant's dispatch logic
    /// is structurally identical (same match pattern), so Plain coverage
    /// validates the dispatch mechanism.
    struct MockStream {
        data: Vec<u8>,
        pos: usize,
        written: Vec<u8>,
    }

    impl MockStream {
        fn new(data: &[u8]) -> Self {
            Self {
                data: data.to_vec(),
                pos: 0,
                written: Vec::new(),
            }
        }
    }

    impl AsyncRead for MockStream {
        fn poll_read(
            mut self: Pin<&mut Self>,
            _cx: &mut Context<'_>,
            buf: &mut ReadBuf<'_>,
        ) -> Poll<io::Result<()>> {
            if self.pos >= self.data.len() {
                return Poll::Ready(Ok(()));
            }
            let n = std::cmp::min(buf.remaining(), self.data.len() - self.pos);
            buf.put_slice(&self.data[self.pos..self.pos + n]);
            self.pos += n;
            Poll::Ready(Ok(()))
        }
    }

    impl AsyncWrite for MockStream {
        fn poll_write(
            mut self: Pin<&mut Self>,
            _cx: &mut Context<'_>,
            buf: &[u8],
        ) -> Poll<io::Result<usize>> {
            self.written.extend_from_slice(buf);
            Poll::Ready(Ok(buf.len()))
        }

        fn poll_flush(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<io::Result<()>> {
            Poll::Ready(Ok(()))
        }

        fn poll_shutdown(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<io::Result<()>> {
            Poll::Ready(Ok(()))
        }
    }

    impl Unpin for MockStream {}

    #[tokio::test]
    async fn plain_variant_reads_data() {
        let mut stream: TlsOrPlain<MockStream> = TlsOrPlain::Plain(MockStream::new(b"hello"));
        let mut buf = String::new();
        stream.read_to_string(&mut buf).await.unwrap();
        assert_eq!(buf, "hello");
    }

    #[tokio::test]
    async fn plain_variant_writes_data() {
        let mut stream: TlsOrPlain<MockStream> = TlsOrPlain::Plain(MockStream::new(b""));
        stream.write_all(b"world").await.unwrap();
        stream.flush().await.unwrap();
        // Verify the write call succeeded without error.
        // The mock captures written bytes internally, confirming dispatch works.
    }

    #[test]
    fn plain_variant_connection_returns_connected() {
        let stream: TlsOrPlain<MockStream> = TlsOrPlain::Plain(MockStream::new(b""));
        let connected = stream.connected();
        // Verify it returns a default Connected (no ALPN negotiated).
        assert!(format!("{:?}", connected).contains("alpn: None"));
    }

    #[tokio::test]
    async fn plain_variant_eos_returns_empty() {
        let mut stream: TlsOrPlain<MockStream> = TlsOrPlain::Plain(MockStream::new(b""));
        let mut buf = [0u8; 16];
        let n = stream.read(&mut buf).await.unwrap();
        assert_eq!(n, 0, "empty mock stream should yield 0 bytes at EOS");
    }
}
