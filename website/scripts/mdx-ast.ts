import type { Definition, Heading, Link, LinkReference, Root } from 'mdast';
import { toString as nodeText } from 'mdast-util-to-string';
import type { Node, Parent } from 'unist';

type DocumentHeading = {
  readonly depth: number;
  readonly line: number;
  readonly text: string;
};

type DocumentLink = {
  readonly href: string;
  readonly line: number;
};

function isParent(node: Node): node is Parent {
  return 'children' in node && Array.isArray(node.children);
}

function walk(node: Node, visit: (child: Node) => void): void {
  visit(node);
  if (!isParent(node)) {
    return;
  }

  for (const child of node.children) {
    walk(child, visit);
  }
}

function isDefinition(node: Node): node is Definition {
  return node.type === 'definition';
}

function isHeading(node: Node): node is Heading {
  return node.type === 'heading';
}

function isLink(node: Node): node is Link {
  return node.type === 'link';
}

function isLinkReference(node: Node): node is LinkReference {
  return node.type === 'linkReference';
}

export function documentNodes(tree: Root): readonly Node[] {
  const nodes: Node[] = [];
  walk(tree, (node) => nodes.push(node));
  return nodes;
}

export function documentHeadings(tree: Root): readonly DocumentHeading[] {
  return documentNodes(tree)
    .filter(isHeading)
    .map((heading) => ({
      depth: heading.depth,
      line: heading.position?.start.line ?? 1,
      text: nodeText(heading),
    }));
}

export function documentLinks(tree: Root): readonly DocumentLink[] {
  const nodes = documentNodes(tree);
  const definitions = new Map<string, Definition>();

  for (const node of nodes) {
    if (isDefinition(node) && !definitions.has(node.identifier)) {
      definitions.set(node.identifier, node);
    }
  }

  return nodes.flatMap((node) => {
    if (isLink(node)) {
      return [{ href: node.url, line: node.position?.start.line ?? 1 }];
    }

    if (!isLinkReference(node)) {
      return [];
    }

    const definition = definitions.get(node.identifier);
    return definition ? [{ href: definition.url, line: node.position?.start.line ?? 1 }] : [];
  });
}
