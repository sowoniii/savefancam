async function checkProxy() {
  const proxyUrl = 'http://localhost:3000/api/proxy-image?url=' + encodeURIComponent('https://nstatic.dcinside.com/dc/m/img/sp/sp_arrow.png');
  const response = await fetch(proxyUrl);
  console.log('Proxy Status:', response.status);
  console.log('Content-Type:', response.headers.get('content-type'));
  
  const proxyUrl2 = 'http://localhost:3000/api/proxy-image?url=' + encodeURIComponent('https://nstatic.dcinside.com/dc/m/img/sp/sp_image.png');
  const response2 = await fetch(proxyUrl2);
  console.log('Proxy 2 Status:', response2.status);
  console.log('Content-Type 2:', response2.headers.get('content-type'));
}

checkProxy();
