-- 1. Create wallet_topups table
CREATE TABLE IF NOT EXISTS public.wallet_topups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES public.profiles(id) ON DELETE CASCADE,
  upi_id text NOT NULL,
  amount integer NOT NULL, -- enforcing integer type matching the frontend parse
  status text NOT NULL DEFAULT 'pending',
  created_at timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- Enable RLS for wallet_topups
ALTER TABLE public.wallet_topups ENABLE ROW LEVEL SECURITY;

-- Allow insert for authenticated users
DROP POLICY IF EXISTS "Enable insert for auth users" ON public.wallet_topups;
CREATE POLICY "Enable insert for auth users" ON public.wallet_topups
  FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);

-- Allow select for the user themselves and admin
DROP POLICY IF EXISTS "Enable select for owner and admin" ON public.wallet_topups;
CREATE POLICY "Enable select for owner and admin" ON public.wallet_topups
  FOR SELECT USING (auth.uid() = user_id OR auth.uid() = 'f87c88ec-bb43-475f-bb2b-3b1e74869c3b');

-- Allow update for admin only
DROP POLICY IF EXISTS "Enable update for admin" ON public.wallet_topups;
CREATE POLICY "Enable update for admin" ON public.wallet_topups
  FOR UPDATE USING (auth.uid() = 'f87c88ec-bb43-475f-bb2b-3b1e74869c3b');

-- 2. Create trigger function for automatic balance update upon admin approval
CREATE OR REPLACE FUNCTION public.handle_wallet_topup_approval()
RETURNS trigger AS $$
BEGIN
  IF NEW.status = 'approved' AND OLD.status = 'pending' THEN
    UPDATE public.profiles
    SET wallet_balance = COALESCE(wallet_balance, 0) + NEW.amount
    WHERE id = NEW.user_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS wallet_topup_approval_trigger ON public.wallet_topups;
CREATE TRIGGER wallet_topup_approval_trigger
  AFTER UPDATE ON public.wallet_topups
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_wallet_topup_approval();

-- 3. Create server-side OTP generator trigger on orders table
ALTER TABLE public.orders ALTER COLUMN otp TYPE text;

CREATE OR REPLACE FUNCTION public.generate_otp()
RETURNS trigger AS $$
BEGIN
  IF NEW.otp IS NULL THEN
    NEW.otp := (floor(random() * 9000 + 1000))::text;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS order_otp_trigger ON public.orders;
CREATE TRIGGER order_otp_trigger
  BEFORE INSERT OR UPDATE ON public.orders
  FOR EACH ROW
  EXECUTE FUNCTION public.generate_otp();

-- 4. Ensure ratings table has comment, review_text and rider_id columns
ALTER TABLE public.ratings ADD COLUMN IF NOT EXISTS rider_id uuid REFERENCES public.profiles(id) ON DELETE CASCADE;
ALTER TABLE public.ratings ADD COLUMN IF NOT EXISTS comment text;
ALTER TABLE public.ratings ADD COLUMN IF NOT EXISTS review_text text;
ALTER TABLE public.ratings ADD COLUMN IF NOT EXISTS order_id uuid REFERENCES public.orders(id) ON DELETE CASCADE;

-- 5. Ensure support_tickets table has order_id column
ALTER TABLE public.support_tickets ADD COLUMN IF NOT EXISTS order_id uuid REFERENCES public.orders(id) ON DELETE CASCADE;

-- Allow select on support_tickets for admin
DROP POLICY IF EXISTS "Enable select for admin on support_tickets" ON public.support_tickets;
CREATE POLICY "Enable select for admin on support_tickets" ON public.support_tickets
  FOR SELECT USING (auth.uid() = 'f87c88ec-bb43-475f-bb2b-3b1e74869c3b');

-- 6. Prevent active order bypasses from console (Mandatory database validation trigger)
CREATE OR REPLACE FUNCTION public.check_active_order_before_insert()
RETURNS trigger AS $$
DECLARE
  active_count integer;
BEGIN
  SELECT COUNT(*)
  INTO active_count
  FROM public.orders
  WHERE customer_id = NEW.customer_id
    AND status IN ('pending', 'accepted', 'in_transit');
    
  IF active_count > 0 THEN
    RAISE EXCEPTION 'Active booking lock: You already have an active ride request.';
  END IF;
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS check_active_order_trigger ON public.orders;
CREATE TRIGGER check_active_order_trigger
  BEFORE INSERT ON public.orders
  FOR EACH ROW
  EXECUTE FUNCTION public.check_active_order_before_insert();

-- 7. Commission Trigger (Runs inside the database, NO CORS error possible)
CREATE OR REPLACE FUNCTION public.process_ryzo_commission()
RETURNS TRIGGER AS $$
BEGIN
  -- Check if status changed from 'pending' to 'accepted'
  IF (OLD.status = 'pending' AND NEW.status = 'accepted') THEN
    -- Deduct 5 from rider, add 5 to admin
    UPDATE public.profiles SET wallet_balance = COALESCE(wallet_balance, 0) - 5 WHERE id = NEW.rider_id;
    UPDATE public.profiles SET wallet_balance = COALESCE(wallet_balance, 0) + 5 WHERE id = 'f87c88ec-bb43-475f-bb2b-3b1e74869c3b';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trg_deduct_commission ON public.orders;
CREATE TRIGGER trg_deduct_commission
  AFTER UPDATE ON public.orders
  FOR EACH ROW
  EXECUTE FUNCTION public.process_ryzo_commission();

-- 8. Add coordinates columns to orders for live tracking
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS rider_lat double precision;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS rider_lng double precision;
