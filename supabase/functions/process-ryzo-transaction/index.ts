import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.21.0"

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const supabaseClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    )

    const { transaction_type, cust_id, rider_id, delivery_fee } = await req.json()
    const my_admin_fee = 5;

    if (transaction_type === 'bike_ride') {
      // Get current rider profile to retrieve balance
      const { data: riderProfile, error: getRiderError } = await supabaseClient
        .from('profiles')
        .select('wallet_balance')
        .eq('id', rider_id)
        .single()

      if (getRiderError || !riderProfile) {
        throw new Error('Rider profile not found.')
      }

      const newRiderBalance = parseFloat(riderProfile.wallet_balance || 0) - my_admin_fee;

      const { error: updateRiderError } = await supabaseClient
        .from('profiles')
        .update({ wallet_balance: newRiderBalance })
        .eq('id', rider_id);

      if (updateRiderError) throw updateRiderError;

      // Credit admin wallet ('f87c88ec-bb43-475f-bb2b-3b1e74869c3b')
      const { data: adminProfile, error: getAdminError } = await supabaseClient
        .from('profiles')
        .select('wallet_balance')
        .eq('id', 'f87c88ec-bb43-475f-bb2b-3b1e74869c3b')
        .single()

      if (getAdminError || !adminProfile) {
        throw new Error('Admin profile not found.')
      }

      const newAdminBalance = parseFloat(adminProfile.wallet_balance || 0) + my_admin_fee;

      const { error: updateAdminError } = await supabaseClient
        .from('profiles')
        .update({ wallet_balance: newAdminBalance })
        .eq('id', 'f87c88ec-bb43-475f-bb2b-3b1e74869c3b');

      if (updateAdminError) throw updateAdminError;

      return new Response(JSON.stringify({ success: true, message: 'Commission settled successfully.' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 200,
      })
    }

    return new Response(JSON.stringify({ error: 'Invalid transaction type' }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 400,
    })
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 500,
    })
  }
})
