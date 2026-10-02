import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

export function timelineWriteErrors(text, filename) {
  const source = ts.createSourceFile(
    filename,
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const errors = [];
  function visit(node) {
    const property =
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
        ? node.left
        : ts.isCallExpression(node)
          ? node.expression
          : undefined;
    const name =
      property && ts.isPropertyAccessExpression(property)
        ? property.name.text
        : property &&
            ts.isElementAccessExpression(property) &&
            ts.isStringLiteral(property.argumentExpression)
          ? property.argumentExpression.text
          : undefined;
    if (
      name &&
      (ts.isCallExpression(node)
        ? ["scrollTo", "scrollBy", "scrollIntoView"].includes(name)
        : name === "scrollTop")
    ) {
      const { line } = source.getLineAndCharacterOfPosition(node.getStart());
      errors.push(
        `${filename}:${line + 1}: Timeline scroll writes belong in use-timeline-viewport.ts; call a viewport command.`,
      );
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return errors;
}
export function checkTimelineOwner(root) {
  const files = [
    "apps/desktop/src/app/App.tsx",
    "apps/desktop/src/features/conversation/conversation-timeline.tsx",
    "apps/desktop/src/features/conversation/hooks/use-thread-search.ts",
  ];
  return files.flatMap((file) =>
    timelineWriteErrors(readFileSync(resolve(root, file), "utf8"), file),
  );
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const errors = checkTimelineOwner(process.cwd());
  if (errors.length) {
    console.error(errors.join("\n"));
    process.exitCode = 1;
  } else console.log("Timeline scroll ownership passed.");
}
