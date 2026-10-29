import {
  error,
  type Diagnostic,
  type DiagnosticPath,
  type Result,
} from "@living-diorama/content-schema";

export interface RegistryEntry {
  readonly id: string;
  readonly version: string;
}

/** A link from one registry entry to another, found in the entry's data. */
export interface Reference {
  registry: string;
  id: string;
  /** Semver range the target's version must satisfy. */
  versionRange?: string;
  /** Where the reference sits inside the referring entry. */
  path: DiagnosticPath;
  /** Extra checks against the resolved target, e.g. surface params against its schema. */
  check?: (target: RegistryEntry) => Diagnostic[];
}

/** Looks an entry up by registry name and ID, as reference resolution sees them. */
export type Lookup = (registry: string, id: string) => RegistryEntry | undefined;

export interface RegistryOptions<T extends RegistryEntry> {
  /** Validates raw input; `source` labels diagnostics, e.g. `species/core:pebble`. */
  validate: (input: unknown, source: string) => Result<T>;
  /** Lists what an entry refers to, for dependency resolution. */
  references?: (entry: T) => Reference[];
  /**
   * Checks an entry against several of its targets at once, which no single reference can, e.g.
   * that a species has a way of moving. Runs when references resolve, after they are checked.
   */
  check?: (entry: T, lookup: Lookup) => Diagnostic[];
}

/** Holds one version of each namespaced ID. Entries are validated on registration. */
export class Registry<T extends RegistryEntry> {
  readonly #entries = new Map<string, T>();
  readonly #options: RegistryOptions<T>;

  constructor(
    readonly name: string,
    options: RegistryOptions<T>,
  ) {
    this.#options = options;
  }

  register(input: unknown): Result<T> {
    const result = this.validate(input);
    if (result.ok) this.#entries.set(result.value.id, result.value);
    return result;
  }

  /** Checks what `register` checks, that the entry is valid and its ID free, without registering. */
  validate(input: unknown): Result<T> {
    const id =
      typeof input === "object" && input !== null && "id" in input && typeof input.id === "string"
        ? input.id
        : "?";
    const source = `${this.name}/${id}`;
    const result = this.#options.validate(input, source);
    if (!result.ok) return result;

    const entry = result.value;
    const existing = this.#entries.get(entry.id);
    if (existing) {
      return {
        ok: false,
        diagnostics: [
          error(
            "duplicate_id",
            `"${entry.id}" is already registered in ${this.name} (version ${existing.version}; this one is ${entry.version})`,
            ["id"],
            source,
          ),
        ],
      };
    }
    return result;
  }

  get(id: string): T | undefined {
    return this.#entries.get(id);
  }

  has(id: string): boolean {
    return this.#entries.has(id);
  }

  values(): T[] {
    return [...this.#entries.values()];
  }

  get size(): number {
    return this.#entries.size;
  }

  references(entry: T): Reference[] {
    return this.#options.references?.(entry) ?? [];
  }

  /** The entry's checks across its targets (`RegistryOptions.check`). */
  check(entry: T, lookup: Lookup): Diagnostic[] {
    return this.#options.check?.(entry, lookup) ?? [];
  }
}
