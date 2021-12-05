import { EncounterPF2e, RolledCombatant } from "@module/encounter";
import { ErrorPF2e, fontAwesomeIcon } from "@util";
import Sortable from "sortablejs";
import type { SortableEvent } from "sortablejs";

export class EncounterTrackerPF2e extends CombatTracker<EncounterPF2e> {
    sortable!: Sortable;

    /** Fix Foundry setting the title to "Combat Tracker" unlocalized */
    static override get defaultOptions(): CombatTrackerOptions {
        const options = super.defaultOptions;
        options.title = "SIDEBAR.TabCombat";
        return options;
    }

    /** Make the combatants sortable */
    override activateListeners($html: JQuery): void {
        const tracker = $html[0].querySelector<HTMLOListElement>("#combat-tracker");
        if (!tracker) throw ErrorPF2e("No tracker found");

        const encounter = this.viewed;
        if (!encounter) return super.activateListeners($html);

        // Hide names in the tracker of combatants with tokens that have unviewable nameplates
        if (game.settings.get("pf2e", "metagame.tokenSetsNameVisibility")) {
            for (const row of Array.from(tracker.querySelectorAll<HTMLLIElement>("li.combatant"))) {
                const combatantId = row.dataset.combatantId ?? "";
                const combatant = encounter.combatants.get(combatantId, { strict: true });
                const nameElement = row.querySelector<HTMLHRElement>(".token-name h4");
                if (nameElement && !game.user.isGM && !combatant.playersCanSeeName) nameElement.innerText = "";

                if (game.user.isGM && !combatant.actor?.hasPlayerOwner) {
                    const toggleNameVisibility = document.createElement("a");
                    const isActive = combatant.playersCanSeeName;
                    toggleNameVisibility.classList.add(...["combatant-control", isActive ? "active" : []].flat());
                    toggleNameVisibility.dataset.control = "toggle-name-visibility";
                    toggleNameVisibility.title = game.i18n.localize(
                        isActive ? "PF2E.Encounter.HideName" : "PF2E.Encounter.RevealName"
                    );
                    const icon = fontAwesomeIcon("signature");
                    toggleNameVisibility.append(icon);

                    row.querySelector('.combatant-controls a[data-control="toggleHidden"]')?.after(
                        toggleNameVisibility
                    );
                }
            }
        }

        // Defer to Combat Enhancements module if in use
        if (game.user.isGM && !game.modules.get("combat-enhancements")?.active) {
            Sortable.create(tracker, {
                animation: 200,
                dataIdAttr: "data-combatant-id",
                direction: "vertical",
                dragoverBubble: true,
                easing: "cubic-bezier(1, 0, 0, 1)",
                ghostClass: "drag-gap",
                onUpdate: (event) => this.onDropCombatant(event),
                onEnd: () => this.saveNewOrder(),
            });
        }

        super.activateListeners($html);
    }

    /* -------------------------------------------- */
    /*  Event Listeners and Handlers                */
    /* -------------------------------------------- */

    /** Allow CTRL-clicking to make the rolls blind */
    protected override async _onCombatControl(
        event: JQuery.ClickEvent<HTMLElement, HTMLElement, HTMLElement>
    ): Promise<void> {
        const control = event.currentTarget.dataset.control;
        if ((control === "rollNPC" || control === "rollAll") && this.viewed && event.ctrlKey) {
            event.stopPropagation();
            await this.viewed[control]({ secret: true });
        } else {
            await super._onCombatControl(event);
        }
    }

    /** Allow CTRL-clicking to make the roll blind */
    protected override async _onCombatantControl(
        event: JQuery.ClickEvent<HTMLElement, HTMLElement, HTMLElement>
    ): Promise<void> {
        event.stopPropagation();
        if (!this.viewed) return;

        const control = event.currentTarget.dataset.control;
        const li = event.currentTarget.closest<HTMLLIElement>(".combatant");
        const combatant = this.viewed.combatants.get(li?.dataset.combatantId ?? "", { strict: true });

        if (control === "rollInitiative" && event.ctrlKey) {
            await this.viewed.rollInitiative([combatant.id], { secret: true });
        } else if (control === "toggle-name-visibility") {
            await combatant.toggleNameVisibility();
        } else {
            await super._onCombatantControl(event);
        }
    }

    /** Handle the drop event of a dragged & dropped combatant */
    private async onDropCombatant(event: SortableEvent): Promise<void> {
        this.validateDrop(event);

        const encounter = this.viewed!;
        const droppedId = event.item.getAttribute("data-combatant-id") ?? "";
        const dropped = encounter.combatants.get(droppedId, { strict: true }) as RolledCombatant;
        if (typeof dropped.initiative !== "number") {
            ui.notifications.error(game.i18n.format("PF2E.Encounter.HasNoInitiativeScore", { actor: dropped.name }));
            return;
        }

        const newOrder = this.getCombatantsFromDOM();
        const oldOrder = encounter.turns.filter((c) => c.initiative !== null);
        // Exit early if the order wasn't changed
        if (newOrder.every((c) => newOrder.indexOf(c) === oldOrder.indexOf(c))) return;

        this.setInitiativeFromDrop(newOrder, dropped);
        await this.saveNewOrder(newOrder);
    }

    private setInitiativeFromDrop(newOrder: RolledCombatant[], dropped: RolledCombatant): void {
        const aboveDropped = newOrder.find((c) => newOrder.indexOf(c) === newOrder.indexOf(dropped) - 1);
        const belowDropped = newOrder.find((c) => newOrder.indexOf(c) === newOrder.indexOf(dropped) + 1);

        const hasAboveAndBelow = !!aboveDropped && !!belowDropped;
        const hasAboveAndNoBelow = !!aboveDropped && !belowDropped;
        const hasBelowAndNoAbove = !aboveDropped && !!belowDropped;
        const aboveIsHigherThanBelow = hasAboveAndBelow && belowDropped.initiative < aboveDropped.initiative;
        const belowIsHigherThanAbove = hasAboveAndBelow && belowDropped.initiative < aboveDropped.initiative;
        const wasDraggedUp =
            !!belowDropped && this.viewed?.getCombatantWithHigherInit(dropped, belowDropped) === belowDropped;
        const wasDraggedDown = !!aboveDropped && !wasDraggedUp;

        // Set a new initiative intuitively, according to allegedly commonplace intuitions
        dropped.data.initiative =
            hasBelowAndNoAbove || (aboveIsHigherThanBelow && wasDraggedUp)
                ? belowDropped.initiative + 1
                : hasAboveAndNoBelow || (belowIsHigherThanAbove && wasDraggedDown)
                ? aboveDropped.initiative - 1
                : hasAboveAndBelow
                ? belowDropped.initiative
                : dropped.initiative;

        const withSameInitiative = newOrder.filter((c) => c.initiative === dropped.initiative);
        if (withSameInitiative.length > 1) {
            for (let priority = 0; priority < withSameInitiative.length; priority++) {
                withSameInitiative[priority].data.flags.pf2e.overridePriority[dropped.initiative] = priority;
            }
        }
    }

    /** Save the new order, or reset the viewed order if no change was made */
    private async saveNewOrder(newOrder = this.getCombatantsFromDOM()): Promise<void> {
        await this.viewed?.setMultipleInitiatives(
            newOrder.map((c) => ({ id: c.id, value: c.initiative, overridePriority: c.overridePriority(c.initiative) }))
        );
    }

    private validateDrop(event: SortableEvent): void {
        const { combat } = game;
        if (!combat) throw ErrorPF2e("Unexpected error retrieving combat");

        const { oldIndex, newIndex } = event;
        if (!(typeof oldIndex === "number" && typeof newIndex === "number")) {
            throw ErrorPF2e("Unexpected error retrieving new index");
        }
    }

    /** Retrieve the (rolled) combatants in the real-time order as seen in the DOM */
    private getCombatantsFromDOM(): RolledCombatant[] {
        const { combat } = game;
        if (!combat) throw ErrorPF2e("Unexpected error retrieving combat");

        const tracker = document.querySelector<HTMLOListElement>("#combat-tracker");
        if (!tracker) throw ErrorPF2e("Unexpected failure to retriever tracker DOM element");

        return Array.from(tracker.querySelectorAll<HTMLLIElement>("li.combatant"))
            .map((row) => row.getAttribute("data-combatant-id") ?? "")
            .map((id) => combat.combatants.get(id, { strict: true }))
            .filter((c): c is RolledCombatant => typeof c.initiative === "number");
    }
}
