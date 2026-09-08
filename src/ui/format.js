/**
 * Shared formatting for anything the panels display.
 *
 * Durations were minutes all the way up, so a Bogor to Cikarang journey read
 * "142 mnt" and left the reader doing the division. Past an hour people think
 * in hours.
 */

/**
 * A duration, in Indonesian.
 *
 *   45  -> "45 mnt"
 *   60  -> "1 jam"
 *   73  -> "1 jam 13 mnt"
 *
 * Rounds to the nearest minute first, so 59 minutes 40 seconds reads "1 jam"
 * rather than "59 mnt" beside a clock that has already ticked over.
 */
export function formatDuration(seconds) {
    const total = Math.round(seconds / 60);

    if (total < 60) {
        return `${total} mnt`;
    }

    const hours = Math.floor(total / 60),
        rest = total % 60;

    return rest ? `${hours} jam ${rest} mnt` : `${hours} jam`;
}

/** The same, for a countdown: "3 mnt lagi", "1 jam 5 mnt lagi". */
export function formatRemaining(seconds) {
    return `${formatDuration(seconds)} lagi`;
}
