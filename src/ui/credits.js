/**
 * Who the data belongs to, as a panel rather than as a crammed line.
 *
 * Five credits squeezed into Mapbox's attribution badge is technically a
 * credit and reads as boilerplate: the names that matter — the operators whose
 * timetables this whole map is — arrived as a run-on sentence behind an `(i)`.
 * So the badge keeps the one line a casual visitor must see (that this is a
 * simulation, not live positions) and hands the rest to a panel that can say
 * what each source actually gave.
 *
 * Only data sources are listed. The typeface and the bundled libraries have
 * their own obligations and they are met in the repository, in
 * `THIRD-PARTY-NOTICES.md` — putting them in front of a rider looking for
 * which operator runs the Bogor line would bury the answer.
 */

const SOURCES = [
    {
        group: 'Jadwal',
        note: 'Setiap kendaraan di peta ini adalah satu perjalanan terjadwal, ' +
            'dari jadwal resmi operatornya.',
        items: [
            {
                name: 'Transjakarta',
                detail: 'GTFS resmi — BRT, Mikrotrans, Transjabodetabek, Royaltrans',
                url: 'https://gtfs.transjakarta.co.id/'
            },
            {
                name: 'KAI Commuter',
                detail: 'Commuter Line — lin Sentral, Cikarang, Rangkasbitung, Tangerang, Tanjung Priok',
                url: 'https://commuterline.id/'
            },
            {
                name: 'MRT Jakarta',
                detail: 'Lin Utara Selatan',
                url: 'https://jakartamrt.co.id/'
            },
            {
                name: 'LRT Jakarta',
                detail: 'Lin 1',
                url: 'https://lrtjakarta.co.id/'
            },
            {
                name: 'LRT Jabodebek',
                detail: 'Lin Cibubur dan Lin Bekasi',
                url: 'https://lrtjabodebek.kai.id/'
            }
        ]
    },
    {
        group: 'Peta dan geometri',
        items: [
            {
                name: 'OpenStreetMap',
                detail: 'Geometri jalur dan posisi stasiun, di bawah lisensi ODbL',
                url: 'https://www.openstreetmap.org/copyright'
            },
            {
                name: 'Mapbox',
                detail: 'Peta dasar',
                url: 'https://www.mapbox.com/about/maps/'
            }
        ]
    },
    {
        group: 'Suara',
        items: [
            {
                // CC0 asks for no credit. Given anyway, as everything else is.
                name: 'Freesound — Yoyodaman234',
                detail: 'Suara kabin kereta listrik (EMU) saat mengikuti kereta, di bawah CC0. ' +
                    'Pengumuman stasiun dibacakan suara bawaan perangkat',
                url: 'https://freesound.org/people/Yoyodaman234/sounds/341208/'
            }
        ]
    },
    {
        group: 'Perpindahan jalan kaki',
        items: [
            {
                name: 'Transitland',
                detail: '40.466 perpindahan antarhalte, dirutekan dengan Valhalla — ' +
                    'jarak tempuh sebenarnya, bukan garis lurus',
                url: 'https://www.transit.land/terms'
            }
        ]
    },
    {
        group: 'Kodefikasi dan warna lin',
        items: [
            {
                name: 'Pedoman Wayfinding DKI Jakarta',
                detail: 'Lampiran Kepgub No. 31 Tahun 2022, disusun ITDP Indonesia ' +
                    'bersama TfJ-FDTJ untuk Pemprov DKI Jakarta',
                url: 'https://itdp-indonesia.org/publication/pedoman-wayfinding-jakarta/'
            }
        ]
    },
    {
        group: 'Kamera langsung',
        items: [
            {name: 'JakCCTV / Dishub DKI Jakarta', detail: '658 kamera jalan'},
            {name: 'BPJT dan Bina Marga', detail: '140 kamera jalan tol'}
        ]
    }
];

/** Names come from this file, not from a feed, but the habit is cheap. */
function escape(text) {
    return String(text ?? '').replace(/[&<>"]/g, c =>
        ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'})[c]);
}

function row(item) {
    const name = item.url ?
        `<a href="${escape(item.url)}" target="_blank" rel="noopener noreferrer">${
            escape(item.name)}</a>` :
        escape(item.name);

    return `<div class="credit">
        <div class="credit-name">${name}</div>
        <div class="credit-detail">${escape(item.detail)}</div>
    </div>`;
}

export default class Credits {

    constructor() {
        const me = this,
            el = me.el = document.createElement('div');

        el.className = 'credits-scrim';
        el.hidden = true;
        el.innerHTML = `
            <div class="credits panel" role="dialog" aria-modal="true"
                 aria-labelledby="credits-title">
                <div class="credits-head">
                    <h2 class="credits-title" id="credits-title">Sumber data</h2>
                    <button class="credits-close" type="button" aria-label="Tutup">&times;</button>
                </div>
                <div class="credits-body">
                    ${SOURCES.map(section => `
                        <section class="credit-group">
                            <h3 class="credit-group-title">${escape(section.group)}</h3>
                            ${section.note ? `<p class="credit-note">${escape(section.note)}</p>` : ''}
                            ${section.items.map(row).join('')}
                        </section>
                    `).join('')}
                </div>
                <div class="credits-foot">
                    Tidak ada operator di Jabodetabek yang menerbitkan data posisi
                    kendaraan secara langsung. Peta ini menjalankan jadwal, jadi
                    setiap kendaraan berada di tempat jadwalnya seharusnya — bukan
                    di tempatnya sekarang. Hanya kamera CCTV yang menampilkan
                    jalan sebagaimana adanya.
                </div>
            </div>
        `;
        document.body.appendChild(el);

        el.querySelector('.credits-close').addEventListener('click', () => me.hide());

        // The scrim closes, the panel does not — a click that lands on a link
        // inside must not also dismiss what it was read from.
        el.addEventListener('click', event => {
            if (event.target === el) {
                me.hide();
            }
        });

        me._onKey = event => {
            if (event.key === 'Escape') {
                me.hide();
            }
        };
    }

    show() {
        const me = this;

        me.el.hidden = false;
        document.addEventListener('keydown', me._onKey);
        // The close control takes focus, so Escape and Tab both have somewhere
        // to start from rather than leaving the keyboard behind the scrim.
        me.el.querySelector('.credits-close').focus();
        return me;
    }

    /** Idempotent, because Escape and the scrim can both arrive for one close. */
    hide() {
        const me = this;

        me.el.hidden = true;
        document.removeEventListener('keydown', me._onKey);
        return me;
    }
}
