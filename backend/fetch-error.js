

async function test() {
  try {
    const res = await globalThis.fetch('http://localhost:4000/api/stats?range=all');
    const data = await res.json();
    console.log(JSON.stringify(data, null, 2));
  } catch (e) {
    console.error(e);
  }
}
test();
