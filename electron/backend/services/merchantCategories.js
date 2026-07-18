'use strict';

// Built-in, on-device knowledge for cold-start auto-categorization (used by
// services/categorize.js). This is the bundled "lexicon" half of the import
// moat: it lets a brand-new user's *first* import be categorized before any
// per-user MatchRules exist. It ships in the binary — no network, no telemetry.
//
// Mapped categories use the stable default category keys from seed.js
// (food, automobile, utilities, …). categorize.js resolves a key
// to this DB's category row at runtime and skips any key the user deleted, so a
// customised taxonomy never breaks.
//
// Design rule: PRECISION OVER RECALL. A confident wrong category costs more
// user trust than leaving a row blank (the user fixes blanks in one click, and
// that fix trains a MatchRule). Two concrete consequences:
//   1. When a token has two common meanings, omit it (no bare "gas"/"rent"/
//      "store"/"market"/"bar").
//   2. Needles are matched as SUBSTRINGS, so a short needle can hide inside an
//      unrelated word ("macy" in "pharmacy", "gap" in "singapore", "ross" in
//      "red cross"). Such needles are deliberately excluded or qualified
//      ("macys", "boost mobile"); the eval corpus's abstention cases guard this.
// categorize.js matches the LONGEST needle first, so a specific entry
// ("boost mobile", "uber eats") wins over a shorter prefix ("mobil", —).

// ── Noise stripping ───────────────────────────────────────────────────────────
// Bank descriptions bury the merchant in transport noise: payment-network
// prefixes, POS/ACH markers, store numbers, card masks, phone numbers, city/
// state tails. These patterns are removed (in order) before matching so
// "SQ *BLUE BOTTLE COFFEE 866-123 CA" reduces to "blue bottle coffee".
const NOISE_PATTERNS = [
  // Payment-processor / aggregator prefixes (the "<proc> *<merchant>" idiom).
  // NB: no amzn/amazon here — Amazon is a real merchant we want to KEEP, not a
  // third-party passthrough. Stripping "AMZN *2X4" as a prefix blanked Amazon's
  // own retail rows; it now falls through to the '*'→space rule and matches the
  // 'amzn' needle. (Amazon Pay passthrough is rare and still lands in shopping.)
  /\b(sq|tst|sp|pp|paypal|google|goog|apl|apple|toast|clover|venmo|cash app|zelle)\s*\*+\s*/gi,
  // Transaction-type markers banks staple onto the front.
  // NB: no bare "mobile" here — it would eat carrier names (T-Mobile, Boost Mobile).
  /\b(pos|ach|web|recur(?:ring)?|autopay|auto pay|electronic|online|debit card purchase|debit card|credit card|checkcard|check card|chkcard|visa dda pur|visa|mastercard|purchase authorized on|purchase|payment|pmt|withdrawal|ext trnsfr)\b/gi,
  // Card masks, then any remaining stray asterisks (an un-prefixed "uber *eats"
  // or "amzn*2x4" → spaces) so the merchant token is contiguous for matching.
  /[x*]{2,}\d+/gi, // xxxx1234 / ****1234
  /\*+/g,
  /#\s*\d+/g, // store #1234
  /\b\d{3}[-.\s]?\d{3}[-.\s]?\d{4}\b/g, // phone numbers
  /\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/g, // embedded dates
  /\b\d{3,}\b/g, // standalone id/auth/store-number runs (merchant names rarely contain them)
  // Trailing US state abbreviation (a frequent tail on POS rows).
  /\s+(?:al|ak|az|ar|ca|co|ct|de|fl|ga|hi|id|il|in|ia|ks|ky|la|me|md|ma|mi|mn|ms|mo|mt|ne|nv|nh|nj|nm|ny|nc|nd|oh|ok|or|pa|ri|sc|sd|tn|tx|ut|vt|va|wa|wv|wi|wy)\s*$/i,
];

// ── Merchant lexicon ──────────────────────────────────────────────────────────
// [normalized-substring, category-key]. Matched as a substring of the cleaned
// description, longest needle first. High confidence — named brands with a
// single obvious category.
const MERCHANTS = [
  // ── Food — supermarkets & grocery delivery ──
  ['whole foods', 'food'], ['trader joe', 'food'], ['safeway', 'food'],
  ['kroger', 'food'], ['aldi', 'food'], ['publix', 'food'],
  ['wegmans', 'food'], ['sprouts', 'food'], ['instacart', 'food'],
  ['food lion', 'food'], ['harris teeter', 'food'], ['giant eagle', 'food'],
  ['stop & shop', 'food'], ['shoprite', 'food'], ['meijer', 'food'],
  ['ralphs', 'food'], ['vons', 'food'], ['albertsons', 'food'],
  ['winco', 'food'], ['hy-vee', 'food'], ['grocery outlet', 'food'],
  ['fresh market', 'food'], ['save mart', 'food'], ['food 4 less', 'food'],
  ['fred meyer', 'food'], ['lidl', 'food'], ['market basket', 'food'],
  ['smart & final', 'food'],
  // Regional chains & delivery — the long tail of the median grocery run.
  ['jewel-osco', 'food'], ['jewel osco', 'food'], ['acme markets', 'food'],
  ['pavilions', 'food'], ['king soopers', 'food'], ['city market', 'food'],
  ['dillons', 'food'], ['pick n save', 'food'], ['metro market', 'food'],
  ['price chopper', 'food'], ['hannaford', 'food'], ['star market', 'food'],
  ['schnucks', 'food'], ['dierbergs', 'food'], ['tops markets', 'food'],
  ['weis markets', 'food'], ['ingles market', 'food'], ["raley's", 'food'],
  ['raleys', 'food'], ['bashas', 'food'], ['brookshire', 'food'],
  ['cub foods', 'food'], ['piggly wiggly', 'food'], ['h mart', 'food'],
  ['hmart', 'food'], ['99 ranch', 'food'], ['food city', 'food'],
  ['natural grocers', 'food'], ["gelson's", 'food'], ['gelsons', 'food'],
  ['amazon fresh', 'food'], ['freshdirect', 'food'], ['fresh direct', 'food'],
  ['thrive market', 'food'], ['gopuff', 'food'], ['lowes foods', 'food'],
  ["lowe's foods", 'food'], ['qfc', 'food'], ['grocery', 'food'],
  ['supermarket', 'food'],

  // ── Food — restaurants, fast food, coffee, food delivery ──
  ['uber eats', 'food'], ['ubereats', 'food'], ['doordash', 'food'],
  ['grubhub', 'food'], ['postmates', 'food'], ['seamless', 'food'],
  ['caviar', 'food'], ['mcdonald', 'food'], ['starbucks', 'food'],
  ['chipotle', 'food'], ['taco bell', 'food'], ['del taco', 'food'],
  ['burger king', 'food'], ['wendys', 'food'], ["wendy's", 'food'],
  ['subway', 'food'], ['dunkin', 'food'], ['panera', 'food'],
  ['chick-fil-a', 'food'], ['chick fil a', 'food'], ['popeyes', 'food'],
  ['dominos', 'food'], ["domino's", 'food'], ['pizza hut', 'food'],
  ['little caesars', 'food'], ['papa john', 'food'], ['blaze pizza', 'food'],
  ['mod pizza', 'food'], ['kfc', 'food'], ['sonic drive', 'food'],
  ['arbys', 'food'], ["arby's", 'food'], ['jack in the box', 'food'],
  ['in-n-out', 'food'], ['in n out', 'food'], ['five guys', 'food'],
  ['shake shack', 'food'], ['whataburger', 'food'], ['culvers', 'food'],
  ["culver's", 'food'], ['raising cane', 'food'], ['panda express', 'food'],
  // Full brand form only. An abbreviated "NOODLES & CO" loses its trailing " co"
  // to the state-abbreviation strip and can't match this needle; the 'noodle'
  // keyword catches that form (without the clean display name).
  ['noodles & company', 'food'],
  ['qdoba', 'food'], ['olive garden', 'food'],
  ['applebee', 'food'], ['chilis', 'food'], ["chili's", 'food'],
  ['outback steak', 'food'], ['red lobster', 'food'], ['ihop', 'food'],
  ['denny', 'food'], ['waffle house', 'food'], ['cracker barrel', 'food'],
  ['buffalo wild wings', 'food'], ['wingstop', 'food'], ['jersey mike', 'food'],
  ['jimmy john', 'food'], ['firehouse subs', 'food'], ['baskin robbins', 'food'],
  ['dairy queen', 'food'], ['krispy kreme', 'food'], ['el pollo loco', 'food'],
  ['carls jr', 'food'], ["carl's jr", 'food'], ['hardees', 'food'],
  ['bojangles', 'food'], ['zaxby', 'food'], ['white castle', 'food'],
  ['steak n shake', 'food'], ['portillo', 'food'], ['sweetgreen', 'food'],
  ['cava grill', 'food'], ['peets coffee', 'food'], ["peet's coffee", 'food'],
  ['caribou coffee', 'food'], ['tim hortons', 'food'], ['dutch bros', 'food'],
  ['philz coffee', 'food'], ['la colombe', 'food'],
  // Casual/full-service chains, more QSR, smoothies/sweets/bakery.
  ['texas roadhouse', 'food'], ['longhorn steak', 'food'], ['cheesecake factory', 'food'],
  ['pf changs', 'food'], ["p.f. chang", 'food'], ['red robin', 'food'],
  ['tgi fridays', 'food'], ['golden corral', 'food'],
  ['bob evans', 'food'], ['village inn', 'food'],
  ['perkins restaurant', 'food'], ['ruth chris', 'food'],
  ["ruth's chris", 'food'], ['texas de brazil', 'food'], ['benihana', 'food'],
  ['yard house', 'food'], ['cheddars', 'food'], ['bahama breeze', 'food'],
  ['maggiano', 'food'], ['famous dave', 'food'],
  // Qualified forms below — bare 'dickey'/'rubio'/'wetzel'/'captain d' are all
  // surnames or substrings of one (see lexicon-hazards.json).
  ['dickey barbecue', 'food'], ["dickey's barbecue", 'food'], ['dickeys bbq', 'food'],
  ['hooters', 'food'], ['twin peaks restaurant', 'food'],
  ['church chicken', 'food'], ["church's chicken", 'food'], ['pollo tropical', 'food'],
  ["captain d's", 'food'], ['captain ds seafood', 'food'], ['long john silver', 'food'],
  ['moe southwest', 'food'], ["moe's southwest", 'food'],
  ["rubio's", 'food'], ['rubios coastal', 'food'], ['torchy', 'food'], ['freddys frozen', 'food'],
  ["freddy's frozen", 'food'], ['cook out', 'food'], ['checkers drive', 'food'],
  ['sbarro', 'food'], ['auntie anne', 'food'], ['cinnabon', 'food'],
  ["wetzel's", 'food'], ['wetzels pretzel', 'food'], ['jamba juice', 'food'], ['smoothie king', 'food'],
  ['tropical smoothie', 'food'], ['cold stone', 'food'], ['menchie', 'food'],
  ['yogurtland', 'food'], ['crumbl', 'food'], ['insomnia cookies', 'food'],
  ['nothing bundt', 'food'], ['corner bakery', 'food'], ['einstein bros', 'food'],
  ['bruegger', 'food'], ['au bon pain', 'food'], ['pret a manger', 'food'],
  ['nekter', 'food'], ['bonchon', 'food'], ['pei wei', 'food'],
  ['boba guys', 'food'], ['gong cha', 'food'], ['kung fu tea', 'food'],

  // ── Auto & Transport — fuel, rideshare, parts, service ──
  // 'shell' bare hides in "shelly"/"seashell" (see lexicon-hazards.json), so
  // only qualified station forms; 'exxon' alone covers "exxonmobil" ('mobil'
  // bare would eat "mobile deposit").
  ['shell oil', 'automobile'], ['shell service', 'automobile'], ['shell gas', 'automobile'],
  ['chevron', 'automobile'], ['exxon', 'automobile'],
  ['texaco', 'automobile'], ['valero', 'automobile'], ['marathon petro', 'automobile'],
  ['circle k', 'automobile'], ['arco ampm', 'automobile'], ['sunoco', 'automobile'],
  ['speedway', 'automobile'], ['phillips 66', 'automobile'], ['conoco', 'automobile'],
  ['lyft', 'automobile'], ['uber trip', 'automobile'], ['uber technologies', 'automobile'],
  ['autozone', 'automobile'], ['oreilly auto', 'automobile'], ["o'reilly auto", 'automobile'],
  ['pep boys', 'automobile'], ['advance auto', 'automobile'], ['napa auto', 'automobile'],
  ['discount tire', 'automobile'], ['les schwab', 'automobile'], ['jiffy lube', 'automobile'],
  ['valvoline', 'automobile'], ['firestone', 'automobile'], ['midas', 'automobile'],
  ['meineke', 'automobile'], ['maaco', 'automobile'], ['spothero', 'automobile'],
  // More fuel / travel-center brands. Qualified where the bare word is a
  // surname, city, or common substring (love's→"gloves", murphy, gulf→
  // "gulfport", holiday, casey, sinclair broadcast, bp→everything).
  ["casey's general", 'automobile'], ['caseys general', 'automobile'], ['wawa', 'automobile'],
  ['sheetz', 'automobile'], ['quiktrip', 'automobile'], ['quik trip', 'automobile'],
  ['kwik trip', 'automobile'], ['kwik star', 'automobile'], ['racetrac', 'automobile'],
  ['buc-ee', 'automobile'], ['bucees', 'automobile'], ["love's travel", 'automobile'],
  ['loves travel stop', 'automobile'], ['pilot flying j', 'automobile'], ['flying j', 'automobile'],
  ['kum & go', 'automobile'], ['cumberland farms', 'automobile'], ['getgo', 'automobile'],
  ['murphy usa', 'automobile'], ['murphy express', 'automobile'], ['citgo', 'automobile'],
  ['sinclair oil', 'automobile'], ['gulf oil', 'automobile'], ['holiday stationstore', 'automobile'],
  ['maverik', 'automobile'], ['bp products', 'automobile'], ['stewarts shops', 'automobile'],
  // Mid-Atlantic / Northeast convenience-fuel chains (peers of Wawa/Sheetz).
  ['royal farms', 'automobile'], ['rutters', 'automobile'], ["rutter's", 'automobile'],
  ['turkey hill', 'automobile'], ['thorntons', 'automobile'],
  // Rideshare / micromobility / car-share.
  ['zipcar', 'automobile'], ['turo', 'automobile'], ['getaround', 'automobile'],
  ['lime scooter', 'automobile'], ['bird scooter', 'automobile'],
  // EV charging.
  ['chargepoint', 'automobile'], ['evgo', 'automobile'], ['electrify america', 'automobile'],
  ['tesla supercharger', 'automobile'], ['blink charging', 'automobile'],
  // Tolls / transponders (a charge to an account, not intercity travel).
  ['ez pass', 'automobile'], ['ezpass', 'automobile'], ['e-zpass', 'automobile'],
  ['sunpass', 'automobile'], ['fastrak', 'automobile'], ['ipass', 'automobile'],
  ['txtag', 'automobile'], ['pikepass', 'automobile'], ['good to go toll', 'automobile'],
  // Commuter transit agencies (distinctive names only — no bare 3-letter codes).
  ['njtransit', 'automobile'], ['nj transit', 'automobile'], ['caltrain', 'automobile'],
  ['septa', 'automobile'], ['wmata', 'automobile'], ['metra rail', 'automobile'],
  ['mbta', 'automobile'], ['sound transit', 'automobile'], ['clipper card', 'automobile'],
  // Dealers / used-car retail.
  ['carmax', 'automobile'], ['carvana', 'automobile'],

  // ── Entertainment — streaming, gaming, media ──
  ['netflix', 'entertainment'], ['spotify', 'entertainment'], ['hulu', 'entertainment'],
  ['disney plus', 'entertainment'], ['disney+', 'entertainment'], ['hbo max', 'entertainment'],
  ['paramount+', 'entertainment'], ['peacock', 'entertainment'], ['youtube premium', 'entertainment'],
  ['youtube', 'entertainment'], ['prime video', 'entertainment'], ['apple music', 'entertainment'],
  ['apple tv', 'entertainment'], ['itunes', 'entertainment'], ['sirius xm', 'entertainment'],
  ['siriusxm', 'entertainment'], ['tidal', 'entertainment'], ['crunchyroll', 'entertainment'],
  ['steam games', 'entertainment'], ['steampowered', 'entertainment'], ['playstation', 'entertainment'],
  ['nintendo', 'entertainment'], ['xbox', 'entertainment'], ['twitch', 'entertainment'],
  ['epic games', 'entertainment'], ['ea games', 'entertainment'], ['ubisoft', 'entertainment'],
  ['riot games', 'entertainment'], ['roblox', 'entertainment'], ['discord', 'entertainment'],
  ['patreon', 'entertainment'], ['ticketmaster', 'entertainment'], ['fandango', 'entertainment'],
  ['stubhub', 'entertainment'], ['amc theatres', 'entertainment'], ['regal cinemas', 'entertainment'],
  ['cinemark', 'entertainment'], ['audible', 'entertainment'], ['kindle', 'entertainment'],
  ['espn', 'entertainment'], ['starz', 'entertainment'], ['showtime', 'entertainment'],
  ['sling tv', 'entertainment'], ['fubo', 'entertainment'], ['dazn', 'entertainment'],
  // More streaming / VOD.
  ['tubi', 'entertainment'], ['pluto tv', 'entertainment'], ['roku channel', 'entertainment'],
  ['britbox', 'entertainment'], ['acorn tv', 'entertainment'], ['mubi', 'entertainment'],
  ['discovery+', 'entertainment'], ['discovery plus', 'entertainment'], ['amc plus', 'entertainment'],
  ['masterclass', 'entertainment'], ['curiositystream', 'entertainment'], ['funimation', 'entertainment'],
  // More music.
  ['amazon music', 'entertainment'], ['soundcloud', 'entertainment'], ['iheartradio', 'entertainment'],
  ['deezer', 'entertainment'], ['qobuz', 'entertainment'],
  // More gaming (qualified: rockstar→energy drink, blizzard→weather/DQ).
  ['rockstar games', 'entertainment'], ['battle.net', 'entertainment'],
  // 'blizzard ent' (not bare 'blizzard' → snowstorm / DQ Blizzard) catches the
  // usual "BLIZZARD ENT*…" charge as well as the full name.
  ['blizzard entertainment', 'entertainment'], ['blizzard ent', 'entertainment'],
  ['activision', 'entertainment'], ['square enix', 'entertainment'], ['humble bundle', 'entertainment'],
  ['gog.com', 'entertainment'], ['minecraft', 'entertainment'], ['bandai namco', 'entertainment'],
  ['game pass', 'entertainment'],
  // Tickets / live events.
  ['seatgeek', 'entertainment'], ['vivid seats', 'entertainment'], ['eventbrite', 'entertainment'],
  ['gametime', 'entertainment'],
  // Movie theaters (alamo drafthouse beats the 'alamo rent' car needle).
  ['alamo drafthouse', 'entertainment'], ['harkins theatres', 'entertainment'], ['marcus theatres', 'entertainment'],
  ['cinepolis', 'entertainment'], ['studio movie grill', 'entertainment'], ['landmark theatres', 'entertainment'],
  // Attractions / family fun / venues.
  ['topgolf', 'entertainment'], ['dave & buster', 'entertainment'], ["dave and buster", 'entertainment'],
  ['chuck e cheese', 'entertainment'], ['chuck e. cheese', 'entertainment'], ['bowlero', 'entertainment'],
  ['six flags', 'entertainment'], ['cedar point', 'entertainment'], ['universal studios', 'entertainment'],
  ['seaworld', 'entertainment'], ['legoland', 'entertainment'], ['knotts berry', 'entertainment'],
  ['busch gardens', 'entertainment'],
  // Digital media / creators / news subscriptions.
  ['onlyfans', 'entertainment'], ['substack', 'entertainment'], ['new york times', 'entertainment'],
  ['nytimes', 'entertainment'], ['wall street journal', 'entertainment'],

  // ── Health — pharmacies, fitness, care, vision ──
  ['cvs', 'health'], ['walgreen', 'health'], ['rite aid', 'health'],
  ['duane reade', 'health'], ['planet fitness', 'health'], ['la fitness', 'health'],
  ['equinox', 'health'], ['24 hour fitness', 'health'], ['crunch fitness', 'health'],
  ['anytime fitness', 'health'], ['orangetheory', 'health'], ['lifetime fitness', 'health'],
  ["gold's gym", 'health'], ['goldsgym', 'health'], ['ymca', 'health'],
  ['peloton', 'health'], ['gnc', 'health'], ['quest diagnostics', 'health'],
  ['labcorp', 'health'], ['express scripts', 'health'], ['optum', 'health'],
  ['kaiser', 'health'], ['one medical', 'health'], ['minuteclinic', 'health'],
  ['teladoc', 'health'], ['goodrx', 'health'], ['warby parker', 'health'],
  ['lenscrafters', 'health'], ['pearle vision', 'health'], ['aspen dental', 'health'],
  // Boutique fitness / gyms.
  ['crossfit', 'health'], ['soulcycle', 'health'], ['solidcore', 'health'],
  ['pure barre', 'health'], ['club pilates', 'health'], ['cyclebar', 'health'],
  ["barry's bootcamp", 'health'], ['barrys bootcamp', 'health'], ['blink fitness', 'health'],
  ['eos fitness', 'health'], ['esporta fitness', 'health'], ['vasa fitness', 'health'],
  ['chuze fitness', 'health'], ['snap fitness', 'health'], ['retro fitness', 'health'],
  ['new york sports club', 'health'], ['youfit', 'health'],
  // Supplements / wellness / telehealth.
  ['vitamin shoppe', 'health'], ['vitamin world', 'health'], ['bodybuilding.com', 'health'],
  ['betterhelp', 'health'], ['talkspace', 'health'], ['headspace', 'health'],
  ['calm app', 'health'], ['noom', 'health'], ['weight watchers', 'health'],
  ['curology', 'health'], ['cerebral health', 'health'], ['davita', 'health'],
  ['concentra', 'health'],
  // Vision / dental chains.
  ['eyemed', 'health'], ['visionworks', 'health'], ['myeyedr', 'health'],
  ['america best contacts', 'health'], ["america's best contacts", 'health'], ['smiledirect', 'health'],
  ['smile direct club', 'health'], ['western dental', 'health'], ['clearchoice dental', 'health'],

  // ── Utilities — telecom, internet, power, water, TV service ──
  ['comcast', 'utilities'], ['xfinity', 'utilities'], ['verizon', 'utilities'],
  ['at&t', 'utilities'], ['t mobile', 'utilities'], ['t-mobile', 'utilities'],
  ['tmobile', 'utilities'], ['boost mobile', 'utilities'], ['metro pcs', 'utilities'],
  ['metropcs', 'utilities'], ['cricket wireless', 'utilities'], ['us cellular', 'utilities'],
  // No 'sprint' — the brand is retired into T-Mobile and it hides in "sprinter".
  ['google fi', 'utilities'], ['spectrum', 'utilities'],
  ['centurylink', 'utilities'], ['cox comm', 'utilities'], ['optimum', 'utilities'],
  ['mediacom', 'utilities'], ['frontier comm', 'utilities'], ['windstream', 'utilities'],
  ['earthlink', 'utilities'], ['dish network', 'utilities'], ['directv', 'utilities'],
  ['pg&e', 'utilities'], ['xcel energy', 'utilities'], ['dominion energy', 'utilities'],
  ['duke energy', 'utilities'], ['dte energy', 'utilities'], ['ameren', 'utilities'],
  ['consumers energy', 'utilities'], ['georgia power', 'utilities'], ['fpl', 'utilities'],
  ['peco energy', 'utilities'], ['pseg', 'utilities'], ['national grid', 'utilities'],
  ['con edison', 'utilities'], ['coned', 'utilities'], ['socal edison', 'utilities'],
  ['austin energy', 'utilities'],
  // More wireless carriers / MVNOs (qualified where bare is a word:
  // visible, ting→"meeting", straight talk).
  ['mint mobile', 'utilities'], ['visible wireless', 'utilities'], ['straight talk', 'utilities'],
  ['tracfone', 'utilities'], ['simple mobile', 'utilities'], ['xfinity mobile', 'utilities'],
  ['spectrum mobile', 'utilities'], ['total wireless', 'utilities'], ['consumer cellular', 'utilities'],
  ['ting mobile', 'utilities'], ['red pocket', 'utilities'], ['h2o wireless', 'utilities'],
  ['page plus', 'utilities'],
  // More ISPs / broadband / satellite internet.
  ['suddenlink', 'utilities'], ['wow internet', 'utilities'], ['astound broadband', 'utilities'],
  ['ziply fiber', 'utilities'], ['brightspeed', 'utilities'], ['metronet', 'utilities'],
  ['google fiber', 'utilities'], ['starlink', 'utilities'], ['hughesnet', 'utilities'],
  ['viasat', 'utilities'], ['kinetic by windstream', 'utilities'],
  // More electric / gas / energy utilities (regional; qualified where bare is a
  // city/word: spire→"aspire", oncor→"concord", entergy fine).
  ['entergy', 'utilities'], ['eversource', 'utilities'], ['first energy', 'utilities'],
  ['firstenergy', 'utilities'], ['american electric power', 'utilities'], ['ppl electric', 'utilities'],
  ['appalachian power', 'utilities'], ['oncor electric', 'utilities'], ['centerpoint energy', 'utilities'],
  ['salt river project', 'utilities'], ['nv energy', 'utilities'], ['puget sound energy', 'utilities'],
  ['portland general electric', 'utilities'], ['seattle city light', 'utilities'], ['ladwp', 'utilities'],
  ['san diego gas', 'utilities'], ['sdge', 'utilities'], ['socalgas', 'utilities'],
  ['socal gas', 'utilities'], ['nicor gas', 'utilities'], ['columbia gas', 'utilities'],
  ['washington gas', 'utilities'], ['spire energy', 'utilities'], ['cps energy', 'utilities'],
  ['avangrid', 'utilities'],

  // ── Shopping — big-box & online retail, department stores ──
  ['amazon', 'shopping'], ['amzn mktp', 'shopping'], ['amzn', 'shopping'], ['walmart', 'shopping'],
  // Older exports hyphenate/space the brand ("WAL-MART #5849", "WAL MART SUP").
  ['wal-mart', 'shopping'], ['wal mart', 'shopping'],
  ['target', 'shopping'], ['costco', 'shopping'], ['sams club', 'shopping'],
  ['bjs wholesale', 'shopping'], ["bj's wholesale", 'shopping'], ['best buy', 'shopping'],
  ['home depot', 'shopping'], ['lowes', 'shopping'], ["lowe's", 'shopping'],
  ['ikea', 'shopping'], ['etsy', 'shopping'], ['ebay', 'shopping'],
  ['macys', 'shopping'], ["macy's", 'shopping'], ['nordstrom', 'shopping'],
  ['kohls', 'shopping'], ['tj maxx', 'shopping'], ['marshalls', 'shopping'],
  ['old navy', 'shopping'], ['banana republic', 'shopping'], ['sephora', 'shopping'],
  ['ulta', 'shopping'], ['dicks sporting', 'shopping'], ["dick's sporting", 'shopping'],
  ['michaels', 'shopping'], ['hobby lobby', 'shopping'], ['petco', 'shopping'],
  ['petsmart', 'shopping'], ['chewy', 'shopping'], ['staples', 'shopping'],
  ['office depot', 'shopping'], ['wayfair', 'shopping'], ['overstock', 'shopping'],
  ['shein', 'shopping'], ['temu', 'shopping'], ['aliexpress', 'shopping'],
  ['dollar general', 'shopping'], ['dollar tree', 'shopping'], ['family dollar', 'shopping'],
  ['five below', 'shopping'], ['big lots', 'shopping'], ['bed bath', 'shopping'],
  ['gamestop', 'shopping'], ['barnes & noble', 'shopping'], ['nike', 'shopping'],
  ['adidas', 'shopping'], ['lululemon', 'shopping'], ['foot locker', 'shopping'],
  ['zappos', 'shopping'], ['uniqlo', 'shopping'], ['h&m', 'shopping'],
  // Apparel & footwear (qualified where bare is a word/surname/statement line:
  // gap→"singapore", levi→"levine", vans→"caravans", ugg→"luggage",
  // "new balance"→a statement field, american eagle→airline, hollister→city).
  ['gap.com', 'shopping'], ['gap outlet', 'shopping'], ['gap factory', 'shopping'],
  ['athleta', 'shopping'], ['j crew', 'shopping'], ['jcrew', 'shopping'], ['j.crew', 'shopping'],
  ['american eagle outfit', 'shopping'], ['aerie', 'shopping'], ['abercrombie', 'shopping'],
  ['forever 21', 'shopping'], ['urban outfitters', 'shopping'],
  ['anthropologie', 'shopping'], ['free people', 'shopping'], ['madewell', 'shopping'],
  ['everlane', 'shopping'], ['gymshark', 'shopping'], ['vuori', 'shopping'],
  ['north face', 'shopping'], ['patagonia', 'shopping'], ['columbia sportswear', 'shopping'],
  ['rei co-op', 'shopping'], ['rei.com', 'shopping'], ['dsw', 'shopping'],
  ['famous footwear', 'shopping'], ['journeys', 'shopping'], ['vans store', 'shopping'],
  ['vans.com', 'shopping'], ['converse.com', 'shopping'], ['crocs', 'shopping'],
  ['skechers', 'shopping'], ['reebok', 'shopping'], ['puma store', 'shopping'], ['puma.com', 'shopping'],
  ['under armour', 'shopping'], ['newbalance.com', 'shopping'], ['new balance store', 'shopping'],
  ['ralph lauren', 'shopping'], ['tommy hilfiger', 'shopping'], ['calvin klein', 'shopping'],
  ['carhartt', 'shopping'], ['dickies', 'shopping'], ['ugg.com', 'shopping'],
  ['ugg australia', 'shopping'], ['levi strauss', 'shopping'], ["levi's", 'shopping'],
  ["victoria's secret", 'shopping'], ['victorias secret', 'shopping'], ['bath & body works', 'shopping'],
  ['bath and body works', 'shopping'], ['lush cosmetics', 'shopping'], ['sally beauty', 'shopping'],
  ['mac cosmetics', 'shopping'],
  // Home / furniture / decor.
  ['west elm', 'shopping'], ['pottery barn', 'shopping'], ['crate & barrel', 'shopping'],
  ['crate and barrel', 'shopping'], ['restoration hardware', 'shopping'], ['ashley furniture', 'shopping'],
  ['ashley homestore', 'shopping'], ['la-z-boy', 'shopping'], ['world market', 'shopping'],
  ['homegoods', 'shopping'], ['home goods', 'shopping'], ['at home store', 'shopping'],
  ['container store', 'shopping'], ['bob discount furniture', 'shopping'], ["bob's discount furniture", 'shopping'],
  // Home improvement / hardware.
  ['menards', 'shopping'], ['ace hardware', 'shopping'], ['harbor freight', 'shopping'],
  ['tractor supply', 'shopping'], ['true value hardware', 'shopping'], ['sherwin williams', 'shopping'],
  ['sherwin-williams', 'shopping'], ['benjamin moore', 'shopping'], ['floor & decor', 'shopping'],
  // Electronics / office.
  ['apple store', 'shopping'], ['microsoft store', 'shopping'], ['dell.com', 'shopping'],
  ['dell technologies', 'shopping'], ['newegg', 'shopping'], ['b&h photo', 'shopping'],
  ['micro center', 'shopping'],
  // Marketplaces / resale / deals.
  ['mercari', 'shopping'], ['poshmark', 'shopping'], ['depop', 'shopping'],
  ['thredup', 'shopping'], ['stockx', 'shopping'], ['grailed', 'shopping'],
  ['rakuten', 'shopping'], ['groupon', 'shopping'], ['wish.com', 'shopping'],
  // Craft / books / pets.
  ['joann fabric', 'shopping'], ['jo-ann', 'shopping'], ['blick art', 'shopping'],
  ['books a million', 'shopping'], ['half price books', 'shopping'], ['pet supplies plus', 'shopping'],

  // ── Travel — airlines, hotels, booking, car rental ──
  ['united airlines', 'travel'], ['delta air', 'travel'], ['american airlines', 'travel'],
  ['southwest air', 'travel'], ['jetblue', 'travel'], ['alaska air', 'travel'],
  ['spirit air', 'travel'], ['frontier air', 'travel'], ['hawaiian air', 'travel'],
  ['marriott', 'travel'], ['hilton', 'travel'], ['hyatt', 'travel'],
  ['holiday inn', 'travel'], ['best western', 'travel'], ['la quinta', 'travel'],
  ['hampton inn', 'travel'], ['courtyard by', 'travel'], ['motel 6', 'travel'],
  ['super 8', 'travel'], ['airbnb', 'travel'], ['vrbo', 'travel'],
  ['expedia', 'travel'], ['booking.com', 'travel'], ['priceline', 'travel'],
  ['travelocity', 'travel'], ['orbitz', 'travel'], ['kayak', 'travel'],
  ['hertz', 'travel'], ['enterprise rent', 'travel'], ['avis car', 'travel'],
  ['avis rent', 'travel'], ['budget rent', 'travel'], ['national car', 'travel'],
  // More domestic + major international airlines.
  ['allegiant air', 'travel'], ['sun country air', 'travel'], ['virgin atlantic', 'travel'],
  ['british airways', 'travel'], ['air canada', 'travel'], ['lufthansa', 'travel'],
  ['air france', 'travel'], ['klm royal', 'travel'], ['aer lingus', 'travel'],
  ['aeromexico', 'travel'], ['emirates air', 'travel'], ['qatar airways', 'travel'],
  ['etihad', 'travel'], ['turkish airlines', 'travel'], ['japan airlines', 'travel'],
  ['korean air', 'travel'], ['cathay pacific', 'travel'], ['singapore airlines', 'travel'],
  ['copa airlines', 'travel'], ['avianca', 'travel'], ['ryanair', 'travel'], ['easyjet', 'travel'],
  // Hotel brands (qualified where the bare word is a city/surname/appliance:
  // westin→"westinghouse", conrad, fairmont, omni→"omnicom", loews→"lowes").
  ['wyndham', 'travel'], ['ramada', 'travel'], ['days inn', 'travel'],
  ['travelodge', 'travel'], ['howard johnson', 'travel'], ['doubletree', 'travel'],
  ['embassy suites', 'travel'], ['homewood suites', 'travel'], ['home2 suites', 'travel'],
  ['residence inn', 'travel'], ['fairfield inn', 'travel'], ['springhill suites', 'travel'],
  ['towneplace', 'travel'], ['ac hotel', 'travel'], ['aloft hotel', 'travel'],
  ['westin hotel', 'travel'], ['sheraton', 'travel'], ['le meridien', 'travel'],
  ['four points', 'travel'], ['renaissance hotel', 'travel'], ['ritz-carlton', 'travel'],
  ['ritz carlton', 'travel'], ['st regis', 'travel'], ['waldorf astoria', 'travel'],
  ['conrad hotel', 'travel'], ['kimpton', 'travel'], ['intercontinental', 'travel'],
  ['crowne plaza', 'travel'], ['staybridge', 'travel'], ['candlewood suites', 'travel'],
  ['extended stay america', 'travel'], ['red roof inn', 'travel'], ['econo lodge', 'travel'],
  ['quality inn', 'travel'], ['comfort inn', 'travel'], ['comfort suites', 'travel'],
  ['sleep inn', 'travel'], ['country inn', 'travel'], ['sonesta', 'travel'],
  ['omni hotel', 'travel'], ['loews hotel', 'travel'], ['fairmont hotel', 'travel'],
  ['radisson', 'travel'], ['sofitel', 'travel'], ['novotel', 'travel'],
  // Booking / OTA (dots survive the normalizer, so keep them for precision).
  ['hotels.com', 'travel'], ['hotwire', 'travel'], ['agoda', 'travel'],
  ['trip.com', 'travel'], ['hopper travel', 'travel'], ['cheapoair', 'travel'],
  ['tripadvisor', 'travel'], ['viator', 'travel'], ['getyourguide', 'travel'],
  // Cruise lines (bare 'carnival'/'princess'/'celebrity' are too generic).
  ['carnival cruise', 'travel'], ['royal caribbean', 'travel'], ['norwegian cruise', 'travel'],
  ['princess cruise', 'travel'], ['holland america', 'travel'], ['celebrity cruise', 'travel'],
  ['msc cruise', 'travel'], ['disney cruise', 'travel'],
  // More car rental (qualified: alamo→city, thrifty/dollar/sixt→common words).
  ['alamo rent', 'travel'], ['thrifty car', 'travel'], ['dollar rent a car', 'travel'],
  ['sixt rent', 'travel'], ['fox rent a car', 'travel'], ['payless car rental', 'travel'],
  // Trusted-traveler / airport programs.
  ['global entry', 'travel'], ['tsa precheck', 'travel'],
  // 'hospitality' (hotel/restaurant groups) contains the 'hospital' health
  // keyword; as a merchant it's matched first, so it wins and lands in travel.
  ['hospitality', 'travel'],

  // ── Insurance — carriers (a dedicated bucket makes the "insurance" keyword safe) ──
  ['geico', 'insurance'], ['state farm', 'insurance'], ['progressive ins', 'insurance'],
  ['allstate', 'insurance'], ['liberty mutual', 'insurance'], ['nationwide ins', 'insurance'],
  ['farmers ins', 'insurance'], ['aflac', 'insurance'], ['metlife', 'insurance'],
  // More P&C / auto / home / life carriers. Qualified where bare is a word or
  // city: travelers→travel, mercury, root, lemonade, chubb→"chubby",
  // erie→city, usaa→also a bank ("USAA TRANSFER" must stay blank).
  ['the hartford', 'insurance'], ['travelers ins', 'insurance'], ['american family ins', 'insurance'],
  ['erie insurance', 'insurance'], ['auto-owners ins', 'insurance'], ['mercury ins', 'insurance'],
  ['safeco', 'insurance'], ['esurance', 'insurance'], ['root insurance', 'insurance'],
  ['lemonade insurance', 'insurance'], ['amica', 'insurance'], ['usaa insurance', 'insurance'],
  ['new york life', 'insurance'], ['northwestern mutual', 'insurance'], ['guardian life', 'insurance'],
  ['mutual of omaha', 'insurance'], ['chubb insurance', 'insurance'], ['cincinnati insurance', 'insurance'],
  ['unum', 'insurance'],

  // ── Investing — brokerages, retirement, robo-advisors, crypto exchanges ──
  // Direction-guarded in categorize.js: applies only to OUTFLOW rows (a debit
  // to a brokerage is a contribution/buy → investing). An inflow from one is a
  // withdrawal, not income, so it deliberately stays blank.
  // Deliberate omissions (two common meanings): bare 'sofi' (hides in "sofia";
  // SoFi is also a lender/bank), bare 'merrill' ("merrillville"), bare
  // 'kraken' (Seattle Kraken), bare 'gemini' (Google Gemini), bare
  // 'empower'/'principal' (generic words), 'e trade' ("singapore trade co"),
  // john hancock / transamerica (as much insurance as retirement).
  ['robinhood', 'investing'], ['coinbase', 'investing'], ['vanguard', 'investing'],
  ['fidelity', 'investing'], ['fid bkg svc', 'investing'],
  ['charles schwab', 'investing'], ['schwab', 'investing'],
  ['etrade', 'investing'], ['trade securities', 'investing'],
  ['td ameritrade', 'investing'], ['ameritrade', 'investing'],
  ['webull', 'investing'], ['betterment', 'investing'], ['wealthfront', 'investing'],
  ['acorns', 'investing'], ['stash capital', 'investing'], ['public investing', 'investing'],
  ['m1 finance', 'investing'], ['sofi invest', 'investing'], ['sofi securities', 'investing'],
  ['interactive brokers', 'investing'], ['tastytrade', 'investing'],
  ['tradestation', 'investing'], ['thinkorswim', 'investing'],
  ['ally invest', 'investing'], ['apex clearing', 'investing'],
  ['merrill lynch', 'investing'], ['merrill edge', 'investing'],
  ['morgan stanley', 'investing'], ['edward jones', 'investing'],
  ['ameriprise', 'investing'], ['rowe price', 'investing'], ['tiaa', 'investing'],
  ['voya financial', 'investing'], ['empower retirement', 'investing'],
  ['principal financial', 'investing'], ['computershare', 'investing'],
  ['fundrise', 'investing'],
  // Crypto exchanges ('payward' is Kraken's legal/ACH name).
  ['kraken.com', 'investing'], ['payward', 'investing'], ['binance', 'investing'],
  ['gemini trust', 'investing'], ['crypto.com', 'investing'],

  // ── Income — payroll / deposits (direction-guarded in categorize.js) ──
  ['adp payroll', 'income'], ['gusto pay', 'income'], ['payroll', 'income'],
  ['direct deposit', 'income'],
  // More payroll processors (what an employee sees on a paycheck deposit).
  ['paychex', 'income'], ['paycom', 'income'], ['paylocity', 'income'],
  ['trinet', 'income'], ['justworks', 'income'], ['intuit payroll', 'income'],
  ['ceridian', 'income'], ['adp wage', 'income'],
  // Government / benefit deposits (direction-guarded, so inflow-only).
  ['ssa treas', 'other_income'], ['social security admin', 'other_income'],
];

// ── Keyword rules ─────────────────────────────────────────────────────────────
// [normalized-substring, category-key]. Generic descriptive terms (a notch less
// certain than a named brand). Checked only after the merchant lexicon misses,
// in array order (first match wins). Still high-precision: no bare
// "gas"/"store"/"market"/"bar"/"taco"/"tire"/"deli" — each hides inside an
// unrelated word or spans categories.
const KEYWORDS = [
  // Food — restaurant/cafe terms
  ['restaurant', 'food'], ['coffee', 'food'], ['espresso', 'food'],
  ['cafe', 'food'], ['diner', 'food'], ['grill', 'food'],
  ['kitchen', 'food'], ['bistro', 'food'], ['eatery', 'food'],
  ['tavern', 'food'], ['brewery', 'food'], ['brewing', 'food'],
  ['pizzeria', 'food'], ['pizza', 'food'], ['taqueria', 'food'],
  ['burrito', 'food'], ['bakery', 'food'], ['donut', 'food'],
  ['doughnut', 'food'], ['creamery', 'food'], ['steakhouse', 'food'],
  ['sushi', 'food'], ['ramen', 'food'], ['noodle', 'food'],
  ['sandwich', 'food'], ['barbecue', 'food'], ['bbq', 'food'],
  // Food — grocery terms
  ['farmers market', 'food'], ['food mart', 'food'],
  // Auto & Transport
  // Bare 'toll' hides in "toll house"/"tolleson"; only road-shaped forms.
  ['parking', 'automobile'], ['toll road', 'automobile'], ['toll plaza', 'automobile'],
  ['tollway', 'automobile'], ['turnpike', 'automobile'], ['bridge toll', 'automobile'],
  ['toll bridge', 'automobile'], ['tolls', 'automobile'], ['fuel', 'automobile'],
  ['gasoline', 'automobile'], ['gas station', 'automobile'], ['car wash', 'automobile'],
  ['auto parts', 'automobile'], ['auto repair', 'automobile'], ['transit', 'automobile'],
  ['dmv', 'automobile'],
  // Health
  ['pharmacy', 'health'], ['dental', 'health'], ['dentist', 'health'],
  ['clinic', 'health'], ['hospital', 'health'], ['fitness', 'health'],
  ['medical', 'health'], ['wellness', 'health'], ['urgent care', 'health'],
  ['optometry', 'health'], ['optical', 'health'], ['chiropractic', 'health'],
  ['orthodontic', 'health'], ['drugstore', 'health'], ['drug store', 'health'],
  // Utilities (note: "natural gas" → utilities; bare "gas" is intentionally absent)
  ['natural gas', 'utilities'], ['wireless', 'utilities'], ['broadband', 'utilities'],
  ['internet', 'utilities'], ['electric', 'utilities'], ['sewer', 'utilities'],
  ['water dept', 'utilities'], ['water utility', 'utilities'], ['telecom', 'utilities'],
  // Entertainment
  ['cinema', 'entertainment'], ['theatre', 'entertainment'], ['theater', 'entertainment'],
  ['movie', 'entertainment'], ['arcade', 'entertainment'], ['concert', 'entertainment'],
  // Shopping
  ['department store', 'shopping'], ['boutique', 'shopping'],
  // Travel
  ['airlines', 'travel'], ['air lines', 'travel'], ['hotel', 'travel'],
  ['motel', 'travel'], ['resort', 'travel'], ['hostel', 'travel'],
  ['lodging', 'travel'], ['cruise', 'travel'], ['airport', 'travel'],
  ['car rental', 'travel'], ['rental car', 'travel'],
  // Insurance — a dedicated category makes this token safe to map now.
  ['insurance', 'insurance'],
  // Rent — only unambiguous tokens (bare "rent" is a substring of "parent"/
  // "current"; "payment" is stripped as noise).
  ['mortgage', 'rent'], ['property manage', 'rent'], ['leasing office', 'rent'],
  ['apartments', 'rent'], ['apartment homes', 'rent'],
  // Investing (direction-guarded to outflows, like the merchant entries).
  // No bare 'invest' ("investigation") or 'investment' ("XYZ INVESTMENTS LLC"
  // is a common landlord/property-firm name). 'securities'/'brokerage' name a
  // broker-dealer specifically; note 'insurance' is listed earlier, so an
  // "… INSURANCE BROKERAGE" row resolves to insurance, not investing.
  ['securities', 'investing'], ['brokerage', 'investing'],
  ['wealth management', 'investing'],
  // Income / other income (direction-guarded, so these only apply to inflows)
  ['salary', 'income'], ['paycheck', 'income'],
  ['tax refund', 'other_income'], ['irs treas', 'other_income'], ['pension', 'other_income'],
  ['unemployment', 'other_income'], ['dividend', 'other_income'], ['interest paid', 'other_income'],
];

// ── Display names ─────────────────────────────────────────────────────────────
// The ledger shows a clean merchant name for rows the MERCHANT lexicon
// recognizes (keyword rules describe a *kind* of business, not an identity, so
// they never name anything). The name for a needle is DISPLAY_OVERRIDES[needle]
// when present — including an explicit null for generic needles that must never
// rename a row — otherwise autoDisplayName(needle). Names are curated data, held
// to the same precision-first bar as categories: a wrong or ugly name costs
// more trust than the raw bank string.

/** Default display casing for a needle: capitalize each word (and after a
 *  hyphen); short vowel-less tokens read as initialisms (kfc→KFC, tj→TJ, but
 *  never across an apostrophe: d's→D's, not D'S). Pure. */
function autoDisplayName(needle) {
  return needle
    .split(' ')
    .map((tok) => {
      if (tok.length <= 4 && /[a-z]/.test(tok) && !/[aeiou']/.test(tok)) {
        return tok.toUpperCase();
      }
      return tok.replace(/(^|-)([a-z])/g, (m, p, ch) => p + ch.toUpperCase());
    })
    .join(' ');
}

// needle -> canonical brand name. Only needles autoDisplayName gets wrong:
// possessive stems, official casings, needles carrying a disambiguation
// qualifier that isn't part of the brand, and (as null) generics that
// categorize but must not rename. Keys are checked against MERCHANTS by
// lexiconLint.test.js, so a typo here fails the suite instead of silently
// falling back to auto-casing.
const DISPLAY_OVERRIDES = {
  // Generic merchant needles — categorize, never rename.
  grocery: null,
  supermarket: null,
  payroll: null,
  'direct deposit': null,
  hospitality: null,

  // Food — grocery brands
  'trader joe': "Trader Joe's",
  raleys: "Raley's",
  gelsons: "Gelson's",
  'lowes foods': "Lowe's Foods",
  "lowe's foods": "Lowe's Foods",
  winco: 'WinCo Foods',
  shoprite: 'ShopRite',
  freshdirect: 'FreshDirect',
  'fresh direct': 'FreshDirect',
  'jewel osco': 'Jewel-Osco',
  hmart: 'H Mart',
  'pick n save': "Pick 'n Save",
  'tops markets': 'Tops',
  brookshire: "Brookshire's",
  bashas: "Bashas'",
  'ingles market': 'Ingles',

  // Food — restaurant & coffee brands
  ubereats: 'Uber Eats',
  doordash: 'DoorDash',
  mcdonald: "McDonald's",
  wendys: "Wendy's",
  dunkin: "Dunkin'",
  'chick-fil-a': 'Chick-fil-A',
  'chick fil a': 'Chick-fil-A',
  dominos: "Domino's",
  'papa john': "Papa John's",
  'mod pizza': 'MOD Pizza',
  'sonic drive': 'Sonic',
  arbys: "Arby's",
  'in n out': 'In-N-Out',
  culvers: "Culver's",
  'raising cane': "Raising Cane's",
  applebee: "Applebee's",
  chilis: "Chili's",
  'outback steak': 'Outback Steakhouse',
  ihop: 'IHOP',
  denny: "Denny's",
  'jersey mike': "Jersey Mike's",
  'jimmy john': "Jimmy John's",
  'baskin robbins': 'Baskin-Robbins',
  'carls jr': "Carl's Jr.",
  "carl's jr": "Carl's Jr.",
  hardees: "Hardee's",
  zaxby: "Zaxby's",
  'steak n shake': "Steak 'n Shake",
  portillo: "Portillo's",
  'cava grill': 'Cava',
  'peets coffee': "Peet's Coffee",
  'longhorn steak': 'LongHorn Steakhouse',
  'pf changs': "P.F. Chang's",
  'p.f. chang': "P.F. Chang's",
  'tgi fridays': 'TGI Fridays',
  'perkins restaurant': 'Perkins',
  'ruth chris': "Ruth's Chris",
  'texas de brazil': 'Texas de Brazil',
  cheddars: "Cheddar's",
  maggiano: "Maggiano's",
  'famous dave': "Famous Dave's",
  'dickey barbecue': "Dickey's Barbecue Pit",
  "dickey's barbecue": "Dickey's Barbecue Pit",
  'dickeys bbq': "Dickey's Barbecue Pit",
  'twin peaks restaurant': 'Twin Peaks',
  'church chicken': "Church's Chicken",
  'captain ds seafood': "Captain D's",
  'long john silver': "Long John Silver's",
  'moe southwest': "Moe's Southwest Grill",
  "moe's southwest": "Moe's Southwest Grill",
  'rubios coastal': "Rubio's",
  torchy: "Torchy's",
  'freddys frozen': "Freddy's",
  "freddy's frozen": "Freddy's",
  'checkers drive': 'Checkers',
  'auntie anne': "Auntie Anne's",
  "wetzel's": "Wetzel's Pretzels",
  'wetzels pretzel': "Wetzel's Pretzels",
  'cold stone': 'Cold Stone Creamery',
  menchie: "Menchie's",
  'nothing bundt': 'Nothing Bundt Cakes',
  'einstein bros': 'Einstein Bros. Bagels',
  bruegger: "Bruegger's",

  // Auto & Transport
  lyft: 'Lyft', // vowel-less but a word, not an initialism
  'shell oil': 'Shell',
  'shell service': 'Shell',
  'shell gas': 'Shell',
  'marathon petro': 'Marathon',
  'arco ampm': 'ARCO',
  'uber trip': 'Uber',
  'uber technologies': 'Uber',
  'oreilly auto': "O'Reilly Auto Parts",
  "o'reilly auto": "O'Reilly Auto Parts",
  'napa auto': 'NAPA Auto Parts',
  'advance auto': 'Advance Auto Parts',
  autozone: 'AutoZone',
  spothero: 'SpotHero',
  "casey's general": "Casey's",
  'caseys general': "Casey's",
  quiktrip: 'QuikTrip',
  'quik trip': 'QuikTrip',
  racetrac: 'RaceTrac',
  'buc-ee': "Buc-ee's",
  bucees: "Buc-ee's",
  "love's travel": "Love's",
  'loves travel stop': "Love's",
  getgo: 'GetGo',
  'murphy usa': 'Murphy USA',
  'sinclair oil': 'Sinclair',
  'gulf oil': 'Gulf',
  'holiday stationstore': 'Holiday Stationstores',
  'bp products': 'BP',
  'stewarts shops': "Stewart's Shops",
  rutters: "Rutter's",
  "rutter's": "Rutter's",
  'lime scooter': 'Lime',
  'bird scooter': 'Bird',
  chargepoint: 'ChargePoint',
  evgo: 'EVgo',
  'ez pass': 'E-ZPass',
  ezpass: 'E-ZPass',
  'e-zpass': 'E-ZPass',
  sunpass: 'SunPass',
  fastrak: 'FasTrak',
  ipass: 'I-PASS',
  txtag: 'TxTag',
  pikepass: 'PikePass',
  'good to go toll': 'Good To Go',
  njtransit: 'NJ Transit',
  septa: 'SEPTA',
  wmata: 'WMATA',
  'metra rail': 'Metra',
  'clipper card': 'Clipper',
  carmax: 'CarMax',
  citgo: 'CITGO',

  // Entertainment
  'disney plus': 'Disney+',
  'hbo max': 'HBO Max',
  'youtube premium': 'YouTube Premium',
  youtube: 'YouTube',
  'apple tv': 'Apple TV',
  itunes: 'iTunes',
  'sirius xm': 'SiriusXM',
  siriusxm: 'SiriusXM',
  'steam games': 'Steam',
  steampowered: 'Steam',
  playstation: 'PlayStation',
  'ea games': 'EA',
  stubhub: 'StubHub',
  'amc theatres': 'AMC Theatres',
  espn: 'ESPN',
  dazn: 'DAZN',
  'roku channel': 'Roku',
  britbox: 'BritBox',
  mubi: 'MUBI',
  'discovery plus': 'Discovery+',
  'amc plus': 'AMC+',
  masterclass: 'MasterClass',
  curiositystream: 'CuriosityStream',
  soundcloud: 'SoundCloud',
  iheartradio: 'iHeartRadio',
  'blizzard entertainment': 'Blizzard',
  'blizzard ent': 'Blizzard',
  'gog.com': 'GOG.com',
  seatgeek: 'SeatGeek',
  'dave & buster': "Dave & Buster's",
  'dave and buster': "Dave & Buster's",
  'chuck e cheese': 'Chuck E. Cheese',
  'chuck e. cheese': 'Chuck E. Cheese',
  seaworld: 'SeaWorld',
  'knotts berry': "Knott's Berry Farm",
  onlyfans: 'OnlyFans',
  nytimes: 'New York Times',

  // Health
  walgreen: 'Walgreens',
  'la fitness': 'LA Fitness',
  goldsgym: "Gold's Gym",
  ymca: 'YMCA',
  kaiser: 'Kaiser Permanente',
  minuteclinic: 'MinuteClinic',
  goodrx: 'GoodRx',
  lenscrafters: 'LensCrafters',
  crossfit: 'CrossFit',
  soulcycle: 'SoulCycle',
  cyclebar: 'CycleBar',
  'barrys bootcamp': "Barry's Bootcamp",
  'eos fitness': 'EoS Fitness',
  'calm app': 'Calm',
  'cerebral health': 'Cerebral',
  davita: 'DaVita',
  eyemed: 'EyeMed',
  myeyedr: 'MyEyeDr',
  'america best contacts': "America's Best",
  "america's best contacts": "America's Best",
  smiledirect: 'SmileDirectClub',
  'smile direct club': 'SmileDirectClub',
  'clearchoice dental': 'ClearChoice',
  betterhelp: 'BetterHelp',
  youfit: 'YouFit',

  // Utilities
  'at&t': 'AT&T',
  't mobile': 'T-Mobile',
  tmobile: 'T-Mobile',
  'metro pcs': 'MetroPCS',
  metropcs: 'MetroPCS',
  'us cellular': 'US Cellular',
  'cox comm': 'Cox',
  centurylink: 'CenturyLink',
  'frontier comm': 'Frontier',
  earthlink: 'EarthLink',
  directv: 'DIRECTV',
  'pg&e': 'PG&E',
  'dte energy': 'DTE Energy',
  'peco energy': 'PECO',
  pseg: 'PSEG',
  coned: 'Con Edison',
  'socal edison': 'SoCal Edison',
  'visible wireless': 'Visible',
  tracfone: 'TracFone',
  'ting mobile': 'Ting',
  'h2o wireless': 'H2O Wireless',
  'wow internet': 'WOW Internet',
  metronet: 'MetroNet',
  hughesnet: 'HughesNet',
  'kinetic by windstream': 'Kinetic',
  firstenergy: 'FirstEnergy',
  'first energy': 'FirstEnergy',
  'oncor electric': 'Oncor',
  'centerpoint energy': 'CenterPoint Energy',
  ladwp: 'LADWP',
  'san diego gas': 'SDG&E',
  sdge: 'SDG&E',
  socalgas: 'SoCalGas',
  'socal gas': 'SoCalGas',
  'spire energy': 'Spire',

  // Shopping
  'amzn mktp': 'Amazon',
  amzn: 'Amazon',
  'wal-mart': 'Walmart',
  'wal mart': 'Walmart',
  'sams club': "Sam's Club",
  'bjs wholesale': "BJ's Wholesale Club",
  "bj's wholesale": "BJ's Wholesale Club",
  lowes: "Lowe's",
  ikea: 'IKEA',
  ebay: 'eBay',
  macys: "Macy's",
  kohls: "Kohl's",
  'dicks sporting': "Dick's Sporting Goods",
  "dick's sporting": "Dick's Sporting Goods",
  petsmart: 'PetSmart',
  shein: 'SHEIN',
  aliexpress: 'AliExpress',
  'bed bath': 'Bed Bath & Beyond',
  gamestop: 'GameStop',
  'gap.com': 'Gap',
  'gap outlet': 'Gap',
  'gap factory': 'Gap',
  'j crew': 'J.Crew',
  jcrew: 'J.Crew',
  'j.crew': 'J.Crew',
  'american eagle outfit': 'American Eagle',
  'north face': 'The North Face',
  'rei co-op': 'REI',
  'rei.com': 'REI',
  'vans store': 'Vans',
  'vans.com': 'Vans',
  'converse.com': 'Converse',
  'puma store': 'Puma',
  'puma.com': 'Puma',
  'newbalance.com': 'New Balance',
  'new balance store': 'New Balance',
  'ugg.com': 'UGG',
  'ugg australia': 'UGG',
  'levi strauss': "Levi's",
  'victorias secret': "Victoria's Secret",
  'bath and body works': 'Bath & Body Works',
  'lush cosmetics': 'Lush',
  'mac cosmetics': 'MAC Cosmetics',
  homegoods: 'HomeGoods',
  'home goods': 'HomeGoods',
  'at home store': 'At Home',
  'container store': 'The Container Store',
  'bob discount furniture': "Bob's Discount Furniture",
  'true value hardware': 'True Value',
  'ashley homestore': 'Ashley HomeStore',
  'dell.com': 'Dell',
  'dell technologies': 'Dell',
  thredup: 'ThredUp',
  stockx: 'StockX',
  'wish.com': 'Wish',
  'joann fabric': 'JOANN',
  'jo-ann': 'JOANN',
  'blick art': 'Blick',
  'books a million': 'Books-A-Million',
  'crate and barrel': 'Crate & Barrel',
  'sherwin williams': 'Sherwin-Williams',

  // Travel
  'delta air': 'Delta',
  'southwest air': 'Southwest',
  jetblue: 'JetBlue',
  'alaska air': 'Alaska Airlines',
  'spirit air': 'Spirit',
  'frontier air': 'Frontier Airlines',
  'hawaiian air': 'Hawaiian Airlines',
  'allegiant air': 'Allegiant',
  'sun country air': 'Sun Country',
  'klm royal': 'KLM',
  'emirates air': 'Emirates',
  easyjet: 'easyJet',
  'courtyard by': 'Courtyard',
  doubletree: 'DoubleTree',
  'springhill suites': 'SpringHill Suites',
  towneplace: 'TownePlace Suites',
  'ac hotel': 'AC Hotels',
  'aloft hotel': 'Aloft',
  'westin hotel': 'Westin',
  'renaissance hotel': 'Renaissance',
  'st regis': 'St. Regis',
  'conrad hotel': 'Conrad',
  intercontinental: 'InterContinental',
  staybridge: 'Staybridge Suites',
  'omni hotel': 'Omni',
  'loews hotel': 'Loews',
  'fairmont hotel': 'Fairmont',
  'ritz carlton': 'Ritz-Carlton',
  'enterprise rent': 'Enterprise',
  'avis car': 'Avis',
  'avis rent': 'Avis',
  'budget rent': 'Budget',
  'national car': 'National',
  'hopper travel': 'Hopper',
  cheapoair: 'CheapOair',
  getyourguide: 'GetYourGuide',
  'carnival cruise': 'Carnival',
  'norwegian cruise': 'Norwegian Cruise Line',
  'princess cruise': 'Princess Cruises',
  'celebrity cruise': 'Celebrity Cruises',
  'msc cruise': 'MSC Cruises',
  'disney cruise': 'Disney Cruise Line',
  'alamo rent': 'Alamo',
  'thrifty car': 'Thrifty',
  'dollar rent a car': 'Dollar',
  'sixt rent': 'Sixt',
  'fox rent a car': 'Fox',
  'payless car rental': 'Payless',
  'tsa precheck': 'TSA PreCheck',

  // Insurance
  geico: 'GEICO',
  'progressive ins': 'Progressive',
  'nationwide ins': 'Nationwide',
  'farmers ins': 'Farmers Insurance',
  metlife: 'MetLife',
  'travelers ins': 'Travelers',
  'american family ins': 'American Family Insurance',
  'auto-owners ins': 'Auto-Owners',
  'mercury ins': 'Mercury Insurance',
  'lemonade insurance': 'Lemonade',
  'usaa insurance': 'USAA',
  'chubb insurance': 'Chubb',
  'guardian life': 'Guardian',

  // Investing
  'fid bkg svc': 'Fidelity', // Fidelity's ACH descriptor, not a brand name
  schwab: 'Charles Schwab',
  etrade: 'E*TRADE',
  'trade securities': 'E*TRADE', // matches "E*TRADE SECURITIES" post-normalize
  ameritrade: 'TD Ameritrade',
  'rowe price': 'T. Rowe Price',
  tiaa: 'TIAA',
  'voya financial': 'Voya',
  'empower retirement': 'Empower',
  'principal financial': 'Principal',
  'sofi invest': 'SoFi',
  'sofi securities': 'SoFi',
  'stash capital': 'Stash',
  'public investing': 'Public.com',
  'ally invest': 'Ally Invest',
  tastytrade: 'tastytrade', // brand styles itself lowercase
  thinkorswim: 'thinkorswim', // ditto
  tradestation: 'TradeStation',
  'kraken.com': 'Kraken',
  payward: 'Kraken', // Kraken's legal/ACH name
  'gemini trust': 'Gemini',

  // Income
  'adp payroll': 'ADP',
  'adp wage': 'ADP',
  'gusto pay': 'Gusto',
  trinet: 'TriNet',
  'intuit payroll': 'Intuit',
  'ssa treas': 'Social Security',
  'social security admin': 'Social Security',
};

/** Canonical display name for a merchant needle: the curated override when one
 *  exists (null = "recognize but never rename"), else the auto-cased needle. */
function merchantDisplayFor(needle) {
  if (Object.prototype.hasOwnProperty.call(DISPLAY_OVERRIDES, needle)) {
    return DISPLAY_OVERRIDES[needle];
  }
  return autoDisplayName(needle);
}

module.exports = { NOISE_PATTERNS, MERCHANTS, KEYWORDS, DISPLAY_OVERRIDES, merchantDisplayFor };
