// Vector notation exported from the approved Paper homepage.
export function LandingScore({ before = false, cursor }: { before?: boolean; cursor?: number }) {
  return (
<svg className="landing-score-svg" role="img" aria-label={before ? "Piano study in C major" : "Piano study in D major"} viewBox="0 0 1000 190" xmlns="http://www.w3.org/2000/svg" >
              <line x1="20" y1="55" x2="980" y2="55" stroke="#B9C4BD" />
              <line x1="20" y1="69" x2="980" y2="69" stroke="#B9C4BD" />
              <line x1="20" y1="83" x2="980" y2="83" stroke="#B9C4BD" />
              <line x1="20" y1="97" x2="980" y2="97" stroke="#B9C4BD" />
              <line x1="20" y1="111" x2="980" y2="111" stroke="#B9C4BD" />
              <line x1="20" y1="55" x2="20" y2="111" stroke="#65716B" />
              <line x1="260" y1="55" x2="260" y2="111" stroke="#65716B" />
              <line x1="500" y1="55" x2="500" y2="111" stroke="#65716B" />
              <line x1="740" y1="55" x2="740" y2="111" stroke="#65716B" />
              <line x1="980" y1="55" x2="980" y2="111" stroke="#65716B" />
              <text x="36" y="102" fontSize="66" fill="#17201E">
                𝄞
              </text>
              {!before && <><text x="95" y="83" fontSize="26" fill="#17201E">
                ♯
              </text>
              <text x="115" y="65" fontSize="26" fill="#17201E">
                ♯
              </text></>}
              <ellipse cx="160" cy="97" rx="10" ry="7" transform="rotate(-18 160 97)" fill="#17201E" />
              <line x1="169" y1="97" x2="169" y2="55" stroke="#17201E" strokeWidth="2" />
              <ellipse cx="215" cy="83" rx="10" ry="7" transform="rotate(-18 215 83)" fill="#17201E" />
              <line x1="224" y1="83" x2="224" y2="41" stroke="#17201E" strokeWidth="2" />
              <ellipse cx="300" cy="76" rx="10" ry="7" transform="rotate(-18 300 76)" fill="#17201E" />
              <line x1="309" y1="76" x2="309" y2="34" stroke="#17201E" strokeWidth="2" />
              <ellipse cx="360" cy="69" rx="10" ry="7" transform="rotate(-18 360 69)" fill="#17201E" />
              <line x1="369" y1="69" x2="369" y2="27" stroke="#17201E" strokeWidth="2" />
              <ellipse cx="420" cy="83" rx="10" ry="7" transform="rotate(-18 420 83)" fill="#17201E" />
              <line x1="429" y1="83" x2="429" y2="41" stroke="#17201E" strokeWidth="2" />
              <ellipse cx="470" cy="97" rx="10" ry="7" transform="rotate(-18 470 97)" fill="#17201E" />
              <line x1="479" y1="97" x2="479" y2="55" stroke="#17201E" strokeWidth="2" />
              <ellipse cx="550" cy="90" rx="10" ry="7" transform="rotate(-18 550 90)" fill={before ? "#17201E" : "#245B48"} />
              <line x1="559" y1="90" x2="559" y2="48" stroke={before ? "#17201E" : "#245B48"} strokeWidth="2" />
              <ellipse cx="610" cy="76" rx="10" ry="7" transform="rotate(-18 610 76)" fill={before ? "#17201E" : "#245B48"} />
              <line x1="619" y1="76" x2="619" y2="34" stroke={before ? "#17201E" : "#245B48"} strokeWidth="2" />
              <ellipse cx="680" cy="69" rx="10" ry="7" transform="rotate(-18 680 69)" fill={before ? "#17201E" : "#245B48"} />
              <line x1="689" y1="69" x2="689" y2="27" stroke={before ? "#17201E" : "#245B48"} strokeWidth="2" />
              <ellipse cx="795" cy="83" rx="10" ry="7" transform="rotate(-18 795 83)" fill={before ? "#17201E" : "#245B48"} />
              <line x1="804" y1="83" x2="804" y2="41" stroke={before ? "#17201E" : "#245B48"} strokeWidth="2" />
              <ellipse cx="850" cy="76" rx="10" ry="7" transform="rotate(-18 850 76)" fill={before ? "#17201E" : "#245B48"} />
              <line x1="859" y1="76" x2="859" y2="34" stroke={before ? "#17201E" : "#245B48"} strokeWidth="2" />
              <ellipse cx="920" cy="97" rx="10" ry="7" transform="rotate(-18 920 97)" fill={before ? "#17201E" : "#245B48"} />
              <line x1="929" y1="97" x2="929" y2="55" stroke={before ? "#17201E" : "#245B48"} strokeWidth="2" />
              <path d="M295 128 Q380 159 475 128" fill="none" stroke="#65716B" strokeWidth="1.5" />
            {cursor !== undefined && <line x1={cursor} y1="25" x2={cursor} y2="150" stroke="#245B48" strokeWidth="3" />}</svg>
  );
}
