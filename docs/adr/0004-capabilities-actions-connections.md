# ADR 0004: Capabilities, actions and connections

- **Status:** Accepted
- **Date:** 2026-10-25
- **Context:** Roadmap M1 task 3, resolving spec §15.2 (actions vs locomotion), §15.5 (connection `type` vs `requiredCapabilities`), and the parts of §15.3 and §15.4 that the v1 contracts touch.

## Decisions

1. **Locomotion modes are capabilities, not actions.** `core:walk` (later `core:swim`, `core:climb`, `core:fly`) goes in a species' `capabilities` map. Actions are what a creature _does_ over time: `core:idle`, `core:follow_path`, later `core:use_connection`, `core:eat`. Following a path _uses_ the creature's locomotion capabilities. It isn't one of them.

   _Amended by [ADR 0020](0020-body-plans-swimming-and-live-edits.md) §1–§2 (planned, M16 PR 2):_ `core:walk` is renamed `core:land` and `core:swim` is added. Hopping is a land gait, a style that picks the animation, not a capability.

2. **Capabilities are an open keyed map:** `Record<contentId, number>`. The value is a speed factor relative to the species' `baseSpeed` (1 = base speed) and must be positive. A capability that is absent means the creature can't do it. A new pack can add a capability without a schema change.
3. **Connections have no `type`.** `requiredCapabilities` is the only source of truth for who may traverse a connection. The creature needs **all** of the listed capabilities. Alternatives, such as "walk across or swim across", are separate connections. A "bridge connection" is just a connection contributed by a structure placement whose type has the `core:crossable` affordance.
4. **Events find structures through ownership, not names.** `first_use_of_structure` fires when a creature first traverses a connection or enters a region that belongs to a structure placement. The engine never compares structure IDs.
5. **Region kinds are a fixed enum** (`land`, `water`, `cave`, `air`), and graph code treats them all the same. A kind doesn't change navigation rules by itself. Surfaces and connection capabilities do. `cave` is validated in v1 but unused.
6. **No content-named actions** (spec §15.3). Entering a cave or crossing a bridge is generic connection traversal. There is no `enter_cave` action.
7. **Traits and senses are separate maps from capabilities** (spec §15.4). They are left out of the v1 species schema and will be added when needs and senses arrive. Capabilities gate what a creature _can_ do. Senses gate what it _perceives_. Traits tune _how_ it behaves.

## Consequences

- Navigation filters region-graph edges by the creature's capability set alone.
- The illustrative `RegionConnection.type` and the `traits: { "core:swimming": … }` manifest shape are dropped.
