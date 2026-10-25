import { packageName as builtInContent } from "@living-diorama/built-in-content";
import { packageName as contentSchema } from "@living-diorama/content-schema";
import { packageName as desktopIntegration } from "@living-diorama/desktop-integration";
import { packageName as extensionApi } from "@living-diorama/extension-api";
import { packageName as renderer } from "@living-diorama/renderer";
import { packageName as simulation } from "@living-diorama/simulation";

// Placeholder composition root: proves every workspace package resolves from the app.
const packages = [
  contentSchema,
  extensionApi,
  builtInContent,
  simulation,
  renderer,
  desktopIntegration,
];

export function App() {
  return (
    <main className="placeholder">
      <h1>Living Diorama</h1>
      <ul>
        {packages.map((name) => (
          <li key={name}>{name}</li>
        ))}
      </ul>
    </main>
  );
}
