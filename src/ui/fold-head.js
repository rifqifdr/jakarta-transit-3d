import {icon} from '../kodefikasi';

/*
   The header of a panel that folds: Layanan and Lapisan peta.

   The header is the panel's control, not its caption. Folded on a phone it is
   the whole panel — a 48px bar — and Layanan's used to be drawn as an 11px
   tracked-capital label like the section headings inside, so the one thing
   that opened the filters read as a heading rather than as something to press
   (JAKAR-65). It is a button: what the panel is, in sentence case at body
   size, and a summary of what it is holding, so a folded bar still says
   whether anything in it is on. A <button>, because a clickable <div> was the
   only way into those filters and no keyboard could reach it.

   One definition for both panels. Two headers built separately is how the six
   pill buttons drifted into six ideas of what a button is.
*/
export function foldHead({id, glyph, title}) {
    return `<button class="fold-head js-fold" type="button" aria-expanded="true"
                aria-controls="${id}-body">
            ${icon(glyph, 'fold-icon')}
            <span class="fold-title">${title}</span>
            <span class="fold-summary js-summary"></span>
            <span class="chevron" aria-hidden="true"></span>
        </button>`;
}

/** Folds a panel down to its header, or back open, keeping the ARIA state true. */
export function setFolded(el, folded = !el.classList.contains('folded')) {
    el.classList.toggle('folded', folded);
    el.querySelector('.js-fold').setAttribute('aria-expanded', String(!folded));
    return folded;
}
