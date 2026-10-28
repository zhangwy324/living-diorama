import type { LibrarySnapshot, StudioSpecies } from "../studio-protocol";

// The player's drawn species, beside the drawing (roadmap M11 task 6): each with its image, name
// and creatures in the world, to add one, take one out or delete the species. It shows what the
// strip's latest library snapshot says.

export interface MyCreaturesProps {
  /** Undefined until the strip answers. */
  library?: LibrarySnapshot;
  thumbnail(speciesId: string): string | undefined;
  open: boolean;
  onToggle(): void;
  /** The species a request is waiting on, whose buttons are disabled meanwhile. */
  busy?: string;
  /** The last request's failure, in words. */
  message?: string;
  onAdd(speciesId: string): void;
  onRemove(speciesId: string): void;
  onDelete(species: StudioSpecies): void;
}

const reasonsOf = (species: StudioSpecies) =>
  species.available ? "" : species.reasons.map((reason) => reason.message).join(" ");

export function MyCreatures(props: MyCreaturesProps) {
  const { library } = props;
  const count = library?.species.length;
  if (!props.open) {
    return (
      <aside className="my-creatures collapsed">
        <button
          type="button"
          className="my-creatures-toggle"
          aria-expanded={false}
          onClick={props.onToggle}
        >
          My creatures{count ? ` (${count})` : ""}
        </button>
      </aside>
    );
  }
  return (
    <aside className="my-creatures" aria-label="My creatures">
      <div className="my-creatures-header">
        <h2>My creatures</h2>
        <button
          type="button"
          className="my-creatures-toggle"
          aria-expanded={true}
          aria-label="Hide My creatures"
          title="Hide"
          onClick={props.onToggle}
        >
          »
        </button>
      </div>
      {library && (
        <p className="world-count">
          {library.creatures} of {library.maxCreatures} creatures in the world
        </p>
      )}
      {props.message && (
        <p className="panel-message" role="alert">
          {props.message}
        </p>
      )}
      {library?.species.length === 0 && (
        <p className="empty-list">Creatures you release appear here.</p>
      )}
      <ul className="species-list">
        {library?.species.map((species) => {
          const image = props.thumbnail(species.speciesId);
          const busy = props.busy === species.speciesId;
          return (
            <li
              key={species.speciesId}
              className={species.available ? "species" : "species unavailable"}
            >
              {image ? (
                <img className="thumbnail" src={image} alt="" />
              ) : (
                <span className="thumbnail" />
              )}
              <div className="species-text">
                <span className="species-name">{species.name}</span>
                {species.available ? (
                  <span className="species-count">{species.inWorld} in the world</span>
                ) : (
                  <span className="species-reason" title={reasonsOf(species)}>
                    Unavailable: {reasonsOf(species)}
                  </span>
                )}
              </div>
              <div className="species-buttons">
                {species.available && (
                  <>
                    <button
                      type="button"
                      aria-label={`Take one ${species.name} out of the world`}
                      title="Take one out"
                      disabled={busy || species.inWorld === 0}
                      onClick={() => props.onRemove(species.speciesId)}
                    >
                      <Icon d="M3.5 8h9" />
                    </button>
                    <button
                      type="button"
                      aria-label={`Add a ${species.name} to the world`}
                      title="Add one"
                      disabled={busy}
                      onClick={() => props.onAdd(species.speciesId)}
                    >
                      <Icon d="M3.5 8h9M8 3.5v9" />
                    </button>
                  </>
                )}
                <button
                  type="button"
                  className="delete"
                  aria-label={`Delete ${species.name}`}
                  title="Delete"
                  disabled={busy}
                  onClick={() => props.onDelete(species)}
                >
                  <Icon d="M3.5 4.5h9M6.5 4.5V3h3v1.5M4.5 4.5l.7 9h5.6l.7-9" />
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </aside>
  );
}

function Icon({ d }: { d: string }) {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <path className="stroke" d={d} />
    </svg>
  );
}
