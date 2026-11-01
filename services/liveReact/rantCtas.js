/**
 * 🎥 LIVE REACT — the closing call to action said at the end of every
 * Ready-made RANT. Mosh's 99% Done For You offer → "comment 99" → free
 * masterclass. One is picked at random per script so videos don't all end
 * the same way. Added in code (not by the AI) so the offer is never reworded.
 * Edit / add lines freely; keep each one under ~40 words and spoken-sounding.
 */

const CTAS = {
  english: [
    // Mosh's original, tidied
    "If you want to know more about my 99% Done For You program, where we build your online business and mentor you until you earn double your investment back, comment 99 and I'll send you a free masterclass.",
    // Question opener
    "Want an online business without building it all yourself? In my 99% Done For You program, we build it for you and mentor you until you make double your money back. Comment 99 for my free masterclass.",
    // "You don't have to do it alone"
    "You don't have to figure this out alone. My team builds your online business for you, and I mentor you until you earn double what you invested. Comment 99 and I'll send you the free masterclass.",
    // Short and punchy
    "Want us to build your online business for you? That's my 99% Done For You program. We build it, then mentor you until you earn twice your investment back. Comment 99 for the free masterclass.",
    // Leads with the action
    "Comment 99 and I'll send you a free masterclass on my 99% Done For You program. We build your online business for you, and we stay with you until you earn double your investment back.",
  ],
  bengali: [
    'আমার 99% Done For You প্রোগ্রামে আমরা আপনার online business বানিয়ে দিই, আর যতদিন না আপনি investment-এর দ্বিগুণ ফেরত পান, ততদিন mentor করি। জানতে চাইলে comment-এ 99 লিখুন, free masterclass পাঠিয়ে দেব।',
    'Online business চান, কিন্তু সব নিজে বানাতে চান না? আমার 99% Done For You প্রোগ্রামে আমরা বানিয়ে দিই, আর দ্বিগুণ টাকা ফেরত না আসা পর্যন্ত mentor করি। Comment-এ 99 লিখুন, free masterclass পাবেন।',
    'একা একা এটা বুঝতে হবে না। আমার টিম আপনার online business বানিয়ে দেবে, আর investment-এর দ্বিগুণ ফেরত না পাওয়া পর্যন্ত আমি পাশে থাকব। Comment-এ 99 লিখুন, free masterclass পাঠাচ্ছি।',
    'Comment-এ 99 লিখুন, আমার 99% Done For You প্রোগ্রামের free masterclass পাঠিয়ে দেব। আমরা আপনার online business বানিয়ে দিই, আর দ্বিগুণ ফেরত না পাওয়া পর্যন্ত সাথে থাকি।',
  ],
};

function pickCta(language) {
  const list = CTAS[language === 'bengali' ? 'bengali' : 'english'];
  return list[Math.floor(Math.random() * list.length)];
}

module.exports = { CTAS, pickCta };
