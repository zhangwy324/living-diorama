# @living-diorama/built-in-content

The pre-built world and species, registered through `extension-api` exactly as a third-party pack would be.

## Owns

- The v1 diorama world definition, its heightfield asset and generator script output.
- The v1 species definition.

## Must not

- Use any registration path that a third-party pack could not use.
- Be imported by engine packages. Only the app composition root (and dev tools) may import it.

## Workspace dependencies

`@living-diorama/content-schema`, `@living-diorama/extension-api`

Boundary rules are enforced by `pnpm boundaries` (dependency-cruiser) and `pnpm lint`; see roadmap §1.4.
