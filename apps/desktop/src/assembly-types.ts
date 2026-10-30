import {
  formatDiagnostic,
  type Diagnostic,
  type VoxelAssembly,
} from "@living-diorama/content-schema";
import { checkAssemblyTypes, type Registries } from "@living-diorama/extension-api";

// The release-time check of a voxel assembly's part and socket types (ADR 0022, M19 decisions:
// fits are checked at release, structure on load), on the main thread.
//
// The registered types live in the simulation worker, and its protocol has no command to check an
// assembly yet. Until the Studio releases voxel creatures (M21), only the development console does,
// so the main thread loads the same content the worker does, once, the first time it is asked, in
// a chunk of its own that a build which never releases a voxel creature never loads.

let registries: Promise<Registries> | undefined;

function loadRegistries(): Promise<Registries> {
  registries ??= import("./content").then(({ loadContent }) => {
    const content = loadContent();
    if (!content.ok) {
      throw new Error(content.diagnostics.map(formatDiagnostic).join("\n"));
    }
    return content.value;
  });
  return registries;
}

/** What is wrong with `assembly`'s part and socket types in the app's content. */
export const checkAssemblyAgainstContent = async (assembly: VoxelAssembly): Promise<Diagnostic[]> =>
  checkAssemblyTypes(await loadRegistries(), assembly);
