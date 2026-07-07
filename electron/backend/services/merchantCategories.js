'use strict';

// Built-in, on-device knowledge for cold-start auto-categorization (used by
// services/categorize.js). This is the bundled "lexicon" half of the import
// moat: it lets a brand-new user's *first* import be categorized before any
// per-user MatchRules exist. It ships in the binary — no network, no telemetry.
//
// Mapped categories use the stable default category keys from seed.js
// (groceries, dining, automobile, utilities, …). categorize.js resolves a key
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
  /\b(sq|tst|sp|pp|paypal|google|goog|apl|apple|amzn mktp|amazon mktpl|amzn|toast|clover|venmo|cash app|zelle)\s*\*+\s*/gi,
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
  // ── Groceries — supermarkets & grocery delivery ──
  ['whole foods', 'groceries'], ['trader joe', 'groceries'], ['safeway', 'groceries'],
  ['kroger', 'groceries'], ['aldi', 'groceries'], ['publix', 'groceries'],
  ['wegmans', 'groceries'], ['sprouts', 'groceries'], ['instacart', 'groceries'],
  ['food lion', 'groceries'], ['harris teeter', 'groceries'], ['giant eagle', 'groceries'],
  ['stop & shop', 'groceries'], ['shoprite', 'groceries'], ['meijer', 'groceries'],
  ['ralphs', 'groceries'], ['vons', 'groceries'], ['albertsons', 'groceries'],
  ['winco', 'groceries'], ['hy-vee', 'groceries'], ['grocery outlet', 'groceries'],
  ['fresh market', 'groceries'], ['save mart', 'groceries'], ['food 4 less', 'groceries'],
  ['fred meyer', 'groceries'], ['lidl', 'groceries'], ['market basket', 'groceries'],
  ['smart & final', 'groceries'],
  // Regional chains & delivery — the long tail of the median grocery run.
  ['jewel-osco', 'groceries'], ['jewel osco', 'groceries'], ['acme markets', 'groceries'],
  ['pavilions', 'groceries'], ['king soopers', 'groceries'], ['city market', 'groceries'],
  ['dillons', 'groceries'], ['pick n save', 'groceries'], ['metro market', 'groceries'],
  ['price chopper', 'groceries'], ['hannaford', 'groceries'], ['star market', 'groceries'],
  ['schnucks', 'groceries'], ['dierbergs', 'groceries'], ['tops markets', 'groceries'],
  ['weis markets', 'groceries'], ['ingles market', 'groceries'], ["raley's", 'groceries'],
  ['raleys', 'groceries'], ['bashas', 'groceries'], ['brookshire', 'groceries'],
  ['cub foods', 'groceries'], ['piggly wiggly', 'groceries'], ['h mart', 'groceries'],
  ['hmart', 'groceries'], ['99 ranch', 'groceries'], ['food city', 'groceries'],
  ['natural grocers', 'groceries'], ["gelson's", 'groceries'], ['gelsons', 'groceries'],
  ['amazon fresh', 'groceries'], ['freshdirect', 'groceries'], ['fresh direct', 'groceries'],
  ['thrive market', 'groceries'], ['gopuff', 'groceries'], ['lowes foods', 'groceries'],
  ["lowe's foods", 'groceries'], ['qfc', 'groceries'], ['grocery', 'groceries'],
  ['supermarket', 'groceries'],

  // ── Dining — restaurants, fast food, coffee, food delivery ──
  ['uber eats', 'dining'], ['ubereats', 'dining'], ['doordash', 'dining'],
  ['grubhub', 'dining'], ['postmates', 'dining'], ['seamless', 'dining'],
  ['caviar', 'dining'], ['mcdonald', 'dining'], ['starbucks', 'dining'],
  ['chipotle', 'dining'], ['taco bell', 'dining'], ['del taco', 'dining'],
  ['burger king', 'dining'], ['wendys', 'dining'], ["wendy's", 'dining'],
  ['subway', 'dining'], ['dunkin', 'dining'], ['panera', 'dining'],
  ['chick-fil-a', 'dining'], ['chick fil a', 'dining'], ['popeyes', 'dining'],
  ['dominos', 'dining'], ["domino's", 'dining'], ['pizza hut', 'dining'],
  ['little caesars', 'dining'], ['papa john', 'dining'], ['blaze pizza', 'dining'],
  ['mod pizza', 'dining'], ['kfc', 'dining'], ['sonic drive', 'dining'],
  ['arbys', 'dining'], ["arby's", 'dining'], ['jack in the box', 'dining'],
  ['in-n-out', 'dining'], ['in n out', 'dining'], ['five guys', 'dining'],
  ['shake shack', 'dining'], ['whataburger', 'dining'], ['culvers', 'dining'],
  ["culver's", 'dining'], ['raising cane', 'dining'], ['panda express', 'dining'],
  // No 'noodles & co' — the normalizer strips a trailing " co" as a state
  // abbreviation, so it can never match; the 'noodle' keyword covers it.
  ['qdoba', 'dining'], ['olive garden', 'dining'],
  ['applebee', 'dining'], ['chilis', 'dining'], ["chili's", 'dining'],
  ['outback steak', 'dining'], ['red lobster', 'dining'], ['ihop', 'dining'],
  ['denny', 'dining'], ['waffle house', 'dining'], ['cracker barrel', 'dining'],
  ['buffalo wild wings', 'dining'], ['wingstop', 'dining'], ['jersey mike', 'dining'],
  ['jimmy john', 'dining'], ['firehouse subs', 'dining'], ['baskin robbins', 'dining'],
  ['dairy queen', 'dining'], ['krispy kreme', 'dining'], ['el pollo loco', 'dining'],
  ['carls jr', 'dining'], ["carl's jr", 'dining'], ['hardees', 'dining'],
  ['bojangles', 'dining'], ['zaxby', 'dining'], ['white castle', 'dining'],
  ['steak n shake', 'dining'], ['portillo', 'dining'], ['sweetgreen', 'dining'],
  ['cava grill', 'dining'], ['peets coffee', 'dining'], ["peet's coffee", 'dining'],
  ['caribou coffee', 'dining'], ['tim hortons', 'dining'], ['dutch bros', 'dining'],
  ['philz coffee', 'dining'], ['la colombe', 'dining'],
  // Casual/full-service chains, more QSR, smoothies/sweets/bakery.
  ['texas roadhouse', 'dining'], ['longhorn steak', 'dining'], ['cheesecake factory', 'dining'],
  ['pf changs', 'dining'], ["p.f. chang", 'dining'], ['red robin', 'dining'],
  ['tgi fridays', 'dining'], ['golden corral', 'dining'],
  ['bob evans', 'dining'], ['village inn', 'dining'],
  ['perkins restaurant', 'dining'], ['ruth chris', 'dining'],
  ["ruth's chris", 'dining'], ['texas de brazil', 'dining'], ['benihana', 'dining'],
  ['yard house', 'dining'], ['cheddars', 'dining'], ['bahama breeze', 'dining'],
  ['maggiano', 'dining'], ['famous dave', 'dining'],
  // Qualified forms below — bare 'dickey'/'rubio'/'wetzel'/'captain d' are all
  // surnames or substrings of one (see lexicon-hazards.json).
  ['dickey barbecue', 'dining'], ["dickey's barbecue", 'dining'], ['dickeys bbq', 'dining'],
  ['hooters', 'dining'], ['twin peaks restaurant', 'dining'],
  ['church chicken', 'dining'], ["church's chicken", 'dining'], ['pollo tropical', 'dining'],
  ["captain d's", 'dining'], ['captain ds seafood', 'dining'], ['long john silver', 'dining'],
  ['moe southwest', 'dining'], ["moe's southwest", 'dining'],
  ["rubio's", 'dining'], ['rubios coastal', 'dining'], ['torchy', 'dining'], ['freddys frozen', 'dining'],
  ["freddy's frozen", 'dining'], ['cook out', 'dining'], ['checkers drive', 'dining'],
  ['sbarro', 'dining'], ['auntie anne', 'dining'], ['cinnabon', 'dining'],
  ["wetzel's", 'dining'], ['wetzels pretzel', 'dining'], ['jamba juice', 'dining'], ['smoothie king', 'dining'],
  ['tropical smoothie', 'dining'], ['cold stone', 'dining'], ['menchie', 'dining'],
  ['yogurtland', 'dining'], ['crumbl', 'dining'], ['insomnia cookies', 'dining'],
  ['nothing bundt', 'dining'], ['corner bakery', 'dining'], ['einstein bros', 'dining'],
  ['bruegger', 'dining'], ['au bon pain', 'dining'], ['pret a manger', 'dining'],
  ['nekter', 'dining'], ['bonchon', 'dining'], ['pei wei', 'dining'],
  ['boba guys', 'dining'], ['gong cha', 'dining'], ['kung fu tea', 'dining'],

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
  ['rockstar games', 'entertainment'], ['battle.net', 'entertainment'], ['blizzard entertainment', 'entertainment'],
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
  ['amazon', 'shopping'], ['amzn mktp', 'shopping'], ['walmart', 'shopping'],
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
  // Dining
  ['restaurant', 'dining'], ['coffee', 'dining'], ['espresso', 'dining'],
  ['cafe', 'dining'], ['diner', 'dining'], ['grill', 'dining'],
  ['kitchen', 'dining'], ['bistro', 'dining'], ['eatery', 'dining'],
  ['tavern', 'dining'], ['brewery', 'dining'], ['brewing', 'dining'],
  ['pizzeria', 'dining'], ['pizza', 'dining'], ['taqueria', 'dining'],
  ['burrito', 'dining'], ['bakery', 'dining'], ['donut', 'dining'],
  ['doughnut', 'dining'], ['creamery', 'dining'], ['steakhouse', 'dining'],
  ['sushi', 'dining'], ['ramen', 'dining'], ['noodle', 'dining'],
  ['sandwich', 'dining'], ['barbecue', 'dining'], ['bbq', 'dining'],
  // Groceries
  ['farmers market', 'groceries'], ['food mart', 'groceries'],
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
  // Income / other income (direction-guarded, so these only apply to inflows)
  ['salary', 'income'], ['paycheck', 'income'],
  ['tax refund', 'other_income'], ['irs treas', 'other_income'], ['pension', 'other_income'],
  ['unemployment', 'other_income'], ['dividend', 'other_income'], ['interest paid', 'other_income'],
];

module.exports = { NOISE_PATTERNS, MERCHANTS, KEYWORDS };
