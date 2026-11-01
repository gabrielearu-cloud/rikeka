// =====================================================================
// FILTRO PAROLE NON AMMESSE (annunci: titolo e descrizione; chat: messaggi)
// Seconda barriera: le stesse parole sono bloccate anche in firestore.rules
// (funzione testoPulito). Se aggiungi una parola qui, aggiungila anche li'.
// Si confrontano parole intere, per non bloccare parole innocue
// (es. "cazzuola", "zoccoli", "finocchio" restano permesse).
// =====================================================================
export const PAROLE_VIETATE = [
  // volgarita'
  'cazzo', 'cazzi', 'cazzata', 'cazzate', 'cazzone', 'cazzoni', 'cazzuto',
  'minchia', 'minchiata', 'minchiate', 'minchione',
  'merda', 'merde', 'merdoso', 'merdosa', 'merdaccia',
  'stronzo', 'stronza', 'stronzi', 'stronze', 'stronzata', 'stronzate',
  'vaffanculo', 'fanculo', 'affanculo', 'culo', 'inculare', 'inculato', 'inculata',
  'puttana', 'puttane', 'puttanata', 'puttanate', 'puttaniere', 'troia', 'troie', 'troione',
  'zoccola', 'zoccole', 'mignotta', 'mignotte',
  'coglione', 'coglioni', 'coglionata', 'coglionate',
  'figa', 'pompino', 'pompini', 'sborra', 'sborrare', 'segaiolo',
  'bastardo', 'bastarda', 'bastardi', 'bastarde', 'pirla',
  'fottere', 'fottuto', 'fottuta', 'fottuti', 'fottiti', 'sticazzi', 'troiona', 'puttanone',
  // contenuti sessuali espliciti
  'anal', 'anale', 'porno', 'porn', 'pornografia', 'pornografico', 'tette', 'zinne', 'dildo',
  'escort', 'milf', 'hentai', 'orgia', 'orge', 'scopata', 'scopate', 'trombare', 'trombata',
  // bestemmie: generate sotto (BESTEMMIE), qui solo le forme particolari
  'porcodio', 'porcoddio', 'diocan', 'mannaggia dio', 'mannaggia cristo', 'mannaggia la madonna',
  // insulti discriminatori
  'frocio', 'froci', 'ricchione', 'ricchioni', 'negro', 'negri', 'negra', 'negre', 'mongoloide', 'terrone', 'terroni',
  // inglese
  'fuck', 'fucking', 'fucker', 'motherfucker', 'shit', 'bitch', 'cunt', 'asshole', 'nigger', 'faggot', 'pussy', 'cock', 'whore', 'slut'
];

// Bestemmie: nome sacro + insulto, in entrambi gli ordini ("dio cane", "cane dio")
// e scritte attaccate ("diocane"). Non bloccano "dio" o "cane" da soli.
const INSULTI_M = ['cane', 'can', 'porco', 'porcone', 'porcaccio', 'maiale', 'bestia', 'boia', 'ladro', 'ladrone', 'merda',
  'schifoso', 'infame', 'bastardo', 'impestato', 'assassino', 'lurido', 'serpente', 'cornuto', 'maledetto', 'lupo', 'verme', 'stronzo'];
const INSULTI_F = ['cagna', 'porca', 'maiala', 'troia', 'puttana', 'zoccola', 'ladra', 'schifosa', 'infame', 'bastarda',
  'impestata', 'assassina', 'lurida', 'vacca', 'maledetta', 'merda', 'bestia', 'boia', 'serpente', 'lupa', 'stronza'];
const SACRI = [['dio', INSULTI_M], ['cristo', INSULTI_M], ['gesu', INSULTI_M], ['madonna', INSULTI_F]];
export const BESTEMMIE = [...new Set(SACRI.flatMap(([s, insulti]) => insulti.flatMap((i) =>
  [`${s} ${i}`, `${s}${i}`, ...(i === 'can' ? [] : [`${i} ${s}`, `${i}${s}`])])))];
PAROLE_VIETATE.push(...BESTEMMIE.filter((b) => !PAROLE_VIETATE.includes(b)));

// Rende il testo confrontabile: minuscole, senza accenti, numeri al posto di lettere,
// lettere ripetute (cazzzzo) e lettere separate (c a z z o / c.a.z.z.o)
export function normalizza(testo) {
  let t = String(testo || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  t = t.replace(/[0134578@$]/g, (c) => ({ 0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 7: 't', 8: 'b', '@': 'a', $: 's' }[c]));
  t = t.replace(/([a-z])\1{2,}/g, '$1$1');
  t = t.replace(/\b(?:[a-z][\s.\-_*+]+){2,}[a-z]\b/g, (m) => m.replace(/[^a-z]/g, ''));
  return t;
}

const crea = (lista) => new RegExp('(^|[^a-z])(' + lista.map((p) => p.replace(/ /g, '[^a-z]*')).join('|') + ')(?=[^a-z]|$)');
const RE = crea(PAROLE_VIETATE);
// seconda passata con tutte le doppie ridotte a una lettera ("dio caneeee", "merrrda", "caaazzo")
const singole = (t) => t.replace(/([a-z])\1+/g, '$1');
const RE_SINGOLE = crea([...new Set(PAROLE_VIETATE.map(singole))]);

/** Restituisce la prima parola non ammessa trovata, oppure null. */
export function parolaVietata(...testi) {
  for (const t of testi) {
    const n = normalizza(t);
    const m = n.match(RE) || singole(n).match(RE_SINGOLE);
    if (m) return m[2];
  }
  return null;
}
