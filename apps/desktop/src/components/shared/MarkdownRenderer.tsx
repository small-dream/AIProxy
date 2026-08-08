import {
  Box,
  Divider,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Typography,
} from "@mui/material";
import ReactMarkdown, { type Components } from "react-markdown";
import rehypeRaw from "rehype-raw";

import { fontFamilies } from "@/themes/fonts";

type Density = "compact" | "comfortable";

interface SizeScale {
  h1: number;
  h2: number;
  h3: number;
  body: number;
  code: number;
}

const sizeScales: Record<Density, SizeScale> = {
  compact: { h1: 18, h2: 16, h3: 14, body: 13, code: 12 },
  comfortable: { h1: 26, h2: 22, h3: 18, body: 15, code: 13 },
};

export interface MarkdownRendererProps {
  children: string;
  density?: Density;
  /**
   * Maps an href to an in-app slug when it should be handled internally (e.g. a
   * relative *.md reference). Returning null lets the link fall through to its
   * default behavior or onExternalLink. Kept as a prop so this component stays
   * free of docs-domain coupling.
   */
  resolveInternalLink?: (href: string) => string | null;
  /** Invoked for links resolveInternalLink maps to a slug. */
  onInternalLink?: (slug: string) => void;
  /** Invoked for http(s) links (e.g. open in the system browser). */
  onExternalLink?: (href: string) => void;
  /**
   * Parse and render inlined raw HTML (e.g. <a id="..."> anchors). Off by default so
   * untrusted markdown (such as AI summaries) keeps raw HTML escaped rather than
   * interpreted; the docs viewer opts in because its guides are trusted.
   */
  allowHtml?: boolean;
}

export function MarkdownRenderer({
  children,
  density = "comfortable",
  allowHtml = false,
  resolveInternalLink,
  onInternalLink,
  onExternalLink,
}: MarkdownRendererProps) {
  const scale = sizeScales[density];
  const lineHeight = density === "comfortable" ? 1.8 : 1.7;
  const listSx = { pl: 2.5, mb: 1.25, fontSize: scale.body, lineHeight };

  const components: Components = {
    h1: ({ children: label }) => (
      <Typography
        component="h1"
        sx={{ fontSize: scale.h1, fontWeight: 750, mt: 2.5, mb: 1, lineHeight: 1.3 }}
      >
        {label}
      </Typography>
    ),
    h2: ({ children: label }) => (
      <Typography
        component="h2"
        sx={{ fontSize: scale.h2, fontWeight: 750, mt: 2.5, mb: 1, lineHeight: 1.35 }}
      >
        {label}
      </Typography>
    ),
    h3: ({ children: label }) => (
      <Typography
        component="h3"
        sx={{ fontSize: scale.h3, fontWeight: 700, mt: 2, mb: 0.75, lineHeight: 1.4 }}
      >
        {label}
      </Typography>
    ),
    p: ({ children: label }) => (
      <Typography component="p" sx={{ fontSize: scale.body, lineHeight, mb: 1.25 }}>
        {label}
      </Typography>
    ),
    strong: ({ children: label }) => (
      <Box component="strong" sx={{ fontWeight: 700 }}>
        {label}
      </Box>
    ),
    em: ({ children: label }) => (
      <Box component="em" sx={{ fontStyle: "italic" }}>
        {label}
      </Box>
    ),
    code: ({ children: label }) => (
      <Box
        component="code"
        sx={{
          fontFamily: fontFamilies.mono,
          fontSize: scale.code,
          bgcolor: "action.hover",
          borderRadius: 0.5,
          px: 0.5,
          py: 0.25,
        }}
      >
        {label}
      </Box>
    ),
    pre: ({ children: label }) => (
      <Box
        component="pre"
        sx={{
          fontFamily: fontFamilies.mono,
          fontSize: scale.code,
          bgcolor: "action.hover",
          borderRadius: 1,
          p: 1.25,
          overflowX: "auto",
          mb: 1.25,
        }}
      >
        {label}
      </Box>
    ),
    ul: ({ children: label }) => (
      <Box component="ul" sx={listSx}>
        {label}
      </Box>
    ),
    ol: ({ children: label }) => (
      <Box component="ol" sx={listSx}>
        {label}
      </Box>
    ),
    li: ({ children: label }) => (
      <Box component="li" sx={{ mb: 0.25 }}>
        {label}
      </Box>
    ),
    a: ({ href, id, children: label }) => {
      const linkSx = {
        fontSize: scale.body,
        color: "primary.main",
        textDecoration: "underline",
        cursor: "pointer",
      } as const;

      if (href) {
        // In-page anchor: scroll within the article instead of letting the browser
        // touch the hash (which would collide with HashRouter's #/docs?... routing).
        if (href.startsWith("#")) {
          const anchorId = href.slice(1);
          return (
            <Typography
              component="a"
              id={id}
              href={href}
              onClick={(event) => {
                event.preventDefault();
                document.getElementById(anchorId)?.scrollIntoView({ behavior: "smooth" });
              }}
              sx={linkSx}
            >
              {label}
            </Typography>
          );
        }

        const slug = resolveInternalLink?.(href);
        if (slug != null && onInternalLink) {
          const activate = () => onInternalLink(slug);
          return (
            <Typography
              component="a"
              id={id}
              role="link"
              tabIndex={0}
              onClick={(event) => {
                event.preventDefault();
                activate();
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  activate();
                }
              }}
              sx={linkSx}
            >
              {label}
            </Typography>
          );
        }

        if (/^https?:\/\//i.test(href) && onExternalLink) {
          return (
            <Typography
              component="a"
              id={id}
              href={href}
              onClick={(event) => {
                event.preventDefault();
                onExternalLink(href);
              }}
              sx={linkSx}
            >
              {label}
            </Typography>
          );
        }
      }

      return (
        <Typography
          component="a"
          id={id}
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          sx={linkSx}
        >
          {label}
        </Typography>
      );
    },
    blockquote: ({ children: label }) => (
      <Box
        component="blockquote"
        sx={{
          borderLeft: 3,
          borderColor: "divider",
          pl: 1.5,
          my: 1.5,
          color: "text.secondary",
          fontSize: scale.body,
          lineHeight,
        }}
      >
        {label}
      </Box>
    ),
    hr: () => <Divider sx={{ my: 2 }} />,
    table: ({ children: label }) => (
      <TableContainer component={Box} sx={{ mb: 1.5 }}>
        <Table size="small">{label}</Table>
      </TableContainer>
    ),
    thead: ({ children: label }) => <TableHead>{label}</TableHead>,
    tbody: ({ children: label }) => <TableBody>{label}</TableBody>,
    tr: ({ children: label }) => <TableRow>{label}</TableRow>,
    th: ({ children: label }) => (
      <TableCell sx={{ fontWeight: 700, fontSize: scale.code }}>{label}</TableCell>
    ),
    td: ({ children: label }) => <TableCell sx={{ fontSize: scale.body }}>{label}</TableCell>,
  };

  return (
    <ReactMarkdown components={components} rehypePlugins={allowHtml ? [rehypeRaw] : undefined}>
      {children}
    </ReactMarkdown>
  );
}
