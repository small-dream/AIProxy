import type { CollectionTreeNode } from "@/features/collections/use-collections";

/** Recursively count all nodes in the collection tree. */
export function countTreeNodes(nodes: CollectionTreeNode[]): number {
  return nodes.reduce((total, node) => total + 1 + countTreeNodes(node.children), 0);
}

/** Filter the collection tree by a search query, keeping parent nodes with matching children. */
export function filterCollectionTree(nodes: CollectionTreeNode[], query: string): CollectionTreeNode[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return nodes;

  return nodes.flatMap((node) => {
    const children = filterCollectionTree(node.children, normalized);
    if (node.name.toLowerCase().includes(normalized) || children.length > 0) {
      return [{ ...node, children }];
    }
    return [];
  });
}
