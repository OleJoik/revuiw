export interface RootEntry {
  path: string;
  label: string;
  type: "git" | "dir";
  branch?: string;
}

export interface TreeNode {
  name: string;
  type: "file" | "directory";
  path: string;
  children?: TreeNode[];
}

export type Panel = "sidebar" | "viewer" | "chat";
