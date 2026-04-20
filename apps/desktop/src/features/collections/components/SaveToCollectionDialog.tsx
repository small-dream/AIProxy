import {
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  List,
  ListItemButton,
  ListItemText,
  TextField,
  Typography,
} from "@mui/material";
import { useState } from "react";
import type { ApiCollection } from "@aiproxy/shared-types";

import { useCollections, buildCollectionTree, type CollectionTreeNode } from "@/features/collections/use-collections";
import { useI18n } from "@/i18n";

type SaveToCollectionDialogProps = {
  open: boolean;
  sessionName: string;
  onCancel: () => void;
  onConfirm: (collectionId: string, name?: string) => void;
};

export function SaveToCollectionDialog({
  open,
  sessionName,
  onCancel,
  onConfirm,
}: SaveToCollectionDialogProps) {
  const { t } = useI18n();
  const collectionsQuery = useCollections();
  const tree = buildCollectionTree(collectionsQuery.data ?? []);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [name, setName] = useState(sessionName);

  const allCollections = flattenTree(tree);

  return (
    <Dialog open={open} onClose={onCancel} maxWidth="xs" fullWidth>
      <DialogTitle>{t("collectionsPage.saveToCollection")}</DialogTitle>
      <DialogContent>
        <TextField
          fullWidth
          label={t("collectionsPage.requestName")}
          value={name}
          onChange={(e) => setName(e.target.value)}
          sx={{ mt: 1, mb: 2 }}
          size="small"
        />
        <Typography variant="caption" color="text.secondary" sx={{ mb: 1 }}>
          {t("collectionsPage.selectCollection")}
        </Typography>
        <List dense sx={{ maxHeight: 240, overflow: "auto", border: 1, borderColor: "divider", borderRadius: 1 }}>
          {allCollections.map((c) => (
            <ListItemButton
              key={c.id}
              selected={c.id === selectedId}
              onClick={() => setSelectedId(c.id)}
            >
              <ListItemText
                primary={c.name}
                primaryTypographyProps={{ fontSize: 13, pl: c.depth * 2 }}
              />
            </ListItemButton>
          ))}
          {allCollections.length === 0 && (
            <Typography variant="caption" color="text.secondary" sx={{ p: 2 }}>
              {t("collectionsPage.emptyCollections")}
            </Typography>
          )}
        </List>
      </DialogContent>
      <DialogActions>
        <Button onClick={onCancel}>{t("common.actions.cancel")}</Button>
        <Button
          variant="contained"
          disabled={!selectedId}
          onClick={() => {
            if (selectedId) onConfirm(selectedId, name || undefined);
          }}
        >
          {t("collectionsPage.saveToCollection")}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

function flattenTree(nodes: CollectionTreeNode[], depth = 0): Array<ApiCollection & { depth: number }> {
  const result: Array<ApiCollection & { depth: number }> = [];
  for (const node of nodes) {
    result.push({ ...node, depth });
    result.push(...flattenTree(node.children, depth + 1));
  }
  return result;
}
