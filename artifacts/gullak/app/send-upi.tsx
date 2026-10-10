import { UpiPayoutScreen } from '@/components/UpiPayoutScreen';

/** Send to someone else's UPI ID (they don't need Gullak). */
export default function SendToUpiScreen() {
  return <UpiPayoutScreen mode="family" />;
}
