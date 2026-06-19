import MenuBookRoundedIcon from "@mui/icons-material/MenuBookRounded";
import {
  Box,
  FormControl,
  InputLabel,
  List,
  ListItemButton,
  ListItemText,
  ListSubheader,
  MenuItem,
  Paper,
  Select,
  Stack,
  Typography,
} from "@mui/material";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Fragment, useEffect, useMemo, useRef } from "react";
import { useSearchParams } from "react-router-dom";

import { MarkdownRenderer } from "@/components/shared/MarkdownRenderer";
import { getDocContent } from "@/features/docs/docs-content";
import { docsEntries, docsGroupTitleKey } from "@/features/docs/docs-manifest";
import { groupDocsEntries, resolveDocLink, resolveInitialSlug } from "@/features/docs/docs-navigation";
import { useI18n } from "@/i18n";

export function DocsPage() {
  const { t } = useI18n();
  const [searchParams, setSearchParams] = useSearchParams();
  const viewportRef = useRef<HTMLDivElement | null>(null);

  const rawSlug = searchParams.get("doc");
  const activeSlug = useMemo(() => resolveInitialSlug(rawSlug), [rawSlug]);
  const grouped = useMemo(() => groupDocsEntries(), []);
  const content = getDocContent(activeSlug);

  // Normalize the URL when the ?doc= param is missing or points to an unknown guide.
  useEffect(() => {
    if (rawSlug !== activeSlug) {
      setSearchParams({ doc: activeSlug }, { replace: true });
    }
  }, [rawSlug, activeSlug, setSearchParams]);

  // Reset the article scroll position when switching documents.
  useEffect(() => {
    viewportRef.current?.scrollTo({ top: 0 });
  }, [activeSlug]);

  function handleSelect(slug: string) {
    setSearchParams({ doc: slug });
  }

  function handleInternalLink(slug: string) {
    // Only navigate to slugs that actually exist as guides.
    if (docsEntries.some((entry) => entry.slug === slug)) {
      handleSelect(slug);
    }
  }

  function handleExternalLink(href: string) {
    void openUrl(href);
  }

  return (
    <Stack
      spacing={2}
      sx={{ height: "100%", minHeight: 0, maxWidth: 1180, mx: "auto", width: "100%" }}
    >
      <Stack direction="row" spacing={1} alignItems="center" sx={{ flexShrink: 0 }}>
        <MenuBookRoundedIcon sx={{ color: "primary.main", fontSize: 28 }} />
        <Stack spacing={0.25}>
          <Typography variant="h4" sx={{ fontSize: 30, lineHeight: 1.15 }}>
            {t("docsPage.title")}
          </Typography>
          <Typography color="text.secondary" variant="body2">
            {t("docsPage.subtitle")}
          </Typography>
        </Stack>
      </Stack>

      {/* Narrow-screen guide selector (replaces the sidebar below the md breakpoint) */}
      <FormControl
        size="small"
        sx={{ display: { xs: "flex", md: "none" }, flexShrink: 0 }}
      >
        <InputLabel>{t("docsPage.tocSelectLabel")}</InputLabel>
        <Select
          label={t("docsPage.tocSelectLabel")}
          value={activeSlug}
          onChange={(event) => handleSelect(event.target.value)}
        >
          {grouped.flatMap((group) => [
            <ListSubheader key={`group-${group.group}`}>
              {t(docsGroupTitleKey[group.group])}
            </ListSubheader>,
            ...group.entries.map((entry) => (
              <MenuItem key={entry.slug} value={entry.slug}>
                {t(entry.titleKey)}
              </MenuItem>
            )),
          ])}
        </Select>
      </FormControl>

      <Box
        sx={{
          display: "grid",
          gap: 2,
          gridTemplateColumns: { xs: "1fr", md: "260px minmax(0, 1fr)" },
          flex: 1,
          minHeight: 0,
          alignItems: "stretch",
        }}
      >
        {/* Sidebar table of contents (md+) */}
        <Paper
          variant="outlined"
          sx={{
            display: { xs: "none", md: "flex" },
            flexDirection: "column",
            minHeight: 0,
            borderRadius: 2,
            overflow: "hidden",
          }}
        >
          <Typography
            variant="overline"
            sx={{ color: "text.secondary", px: 2, pt: 1.5, flexShrink: 0 }}
          >
            {t("docsPage.tocTitle")}
          </Typography>
          <List dense disablePadding sx={{ minHeight: 0, overflowY: "auto" }}>
            {grouped.map((group) => (
              <Fragment key={group.group}>
                <ListSubheader sx={{ lineHeight: 2, bgcolor: "background.paper" }}>
                  {t(docsGroupTitleKey[group.group])}
                </ListSubheader>
                {group.entries.map((entry) => (
                  <ListItemButton
                    key={entry.slug}
                    selected={entry.slug === activeSlug}
                    onClick={() => handleSelect(entry.slug)}
                  >
                    <ListItemText
                      primary={t(entry.titleKey)}
                      primaryTypographyProps={{ fontSize: 13 }}
                    />
                  </ListItemButton>
                ))}
              </Fragment>
            ))}
          </List>
        </Paper>

        {/* Article viewport */}
        <Paper
          ref={viewportRef}
          variant="outlined"
          sx={{ borderRadius: 2, overflowY: "auto", minHeight: 0 }}
        >
          <Box sx={{ p: { xs: 2, md: 4 }, maxWidth: 820 }}>
            {content ? (
              <MarkdownRenderer
                allowHtml
                density="comfortable"
                resolveInternalLink={resolveDocLink}
                onInternalLink={handleInternalLink}
                onExternalLink={handleExternalLink}
              >
                {content}
              </MarkdownRenderer>
            ) : null}
          </Box>
        </Paper>
      </Box>
    </Stack>
  );
}
