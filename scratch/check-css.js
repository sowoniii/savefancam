async function checkCommonIcons() {
  const cssUrl = 'https://nstatic.dcinside.com/dc/m/css/common.css?v=230925';
  const response = await fetch(cssUrl);
  const text = await response.text();
  
  const matches = text.match(/\.sp-reply[^{]*\{[^}]*\}/g) || [];
  console.log('Matches for .sp-reply in common.css:');
  matches.forEach(m => console.log(m));

  const matchesReload = text.match(/\.sp-reload[^{]*\{[^}]*\}/g) || [];
  console.log('Matches for .sp-reload in common.css:');
  matchesReload.forEach(m => console.log(m));
  
  // Let's also check for other sp- icons or background-image URLs in common.css
  const matchesBg = text.match(/background[^;\}]*url\([^)]*\)[^;\}]*/g) || [];
  console.log('\nSome background URLs in common.css:');
  matchesBg.slice(0, 10).forEach(m => console.log(m));
}

checkCommonIcons();
