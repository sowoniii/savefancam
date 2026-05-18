const { createClient } = require('@supabase/supabase-js');

// Bun automatically loads .env.local, so we can just access process.env directly.
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_ANON_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

async function getIds() {
  const { data, error } = await supabase
    .from('posts')
    .select('id, dc_id, title')
    .limit(5);
  
  if (error) {
    console.error('Error fetching posts:', error);
  } else {
    console.log('Posts:', data);
  }
}

getIds();
