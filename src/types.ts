export interface MenuItem {
  id: string;
  name: string;
  description: string;
  price: string;
  dietaryTags: string[]; // e.g. ["V", "VG", "GF", "DF"]
}

export interface MenuCategory {
  id: string;
  name: string;
  items: MenuItem[];
}

export interface OpeningHours {
  open: string;
  close: string;
  isClosed: boolean;
}

export interface OrderItem {
  id: string;
  name: string;
  price: string;
  quantity: number;
}

export type OrderStatus = "Received" | "Preparing" | "Ready to Serve" | "Completed" | "Cancelled";

export interface OrderFeedback {
  rating: number; // 1-5
  reviewText?: string;
  createdAt: string;
}

export interface Order {
  id: string;
  customerName: string;
  customerPhone: string;
  tableNumber: string;
  items: OrderItem[];
  totalPrice: string;
  status: OrderStatus;
  createdAt: string;
  notes?: string;
  feedback?: OrderFeedback;
}

export interface Theme {
  id: string;
  name: string;
  primary: string;
  bgSoft: string;
  bgLighter: string;
  borderSoft: string;
  badgeBg: string;
  badgeText: string;
}

export const THEME_OPTIONS: Theme[] = [
  { id: "sienna", name: "Warm Sienna", primary: "#d2691e", bgSoft: "#f5f2ed", bgLighter: "#fdfaf6", borderSoft: "#f0e8dc", badgeBg: "#fdf3eb", badgeText: "#d2691e" },
  { id: "emerald", name: "Emerald Mint", primary: "#15803d", bgSoft: "#f0fdf4", bgLighter: "#f6fef9", borderSoft: "#dcfce7", badgeBg: "#e8fdf0", badgeText: "#15803d" },
  { id: "ocean", name: "Ocean Breeze", primary: "#0284c7", bgSoft: "#f0f9ff", bgLighter: "#f7fbfd", borderSoft: "#e0f2fe", badgeBg: "#e0f6ff", badgeText: "#0284c7" },
  { id: "rose", name: "Velvet Burgundy", primary: "#9f1239", bgSoft: "#fff1f2", bgLighter: "#fffafb", borderSoft: "#ffe4e6", badgeBg: "#ffe4e6", badgeText: "#9f1239" },
  { id: "slate", name: "Modern Charcoal", primary: "#334155", bgSoft: "#f1f5f9", bgLighter: "#f8fafc", borderSoft: "#e2e8f0", badgeBg: "#f1f5f9", badgeText: "#334155" },
  { id: "indigo", name: "Sunset Plum", primary: "#6d28d9", bgSoft: "#f5f3ff", bgLighter: "#faf5ff", borderSoft: "#ede9fe", badgeBg: "#f3e8ff", badgeText: "#6d28d9" },
];

export interface RestaurantConfig {
  agentName: string;
  restaurantName: string;
  restaurantType: string;
  address: string;
  phone: string;
  email: string;
  website: string;
  instagram: string;
  tone: string;
  personality: string;
  priceRange: string;
  reservations: string;
  reservationMethod: string;
  parking: string;
  seating: string;
  wifi: boolean;
  wifiPassword?: string;
  kidFriendly: boolean;
  petFriendly: string;
  wheelchairAccessible: boolean;
  currency: string;
  paymentMethods: string[];
  openingHours: {
    [key: string]: OpeningHours;
  };
  menu: MenuCategory[];
  specials: { name: string; description: string; price: string; period: string }[];
  signatureDishes: string[];
  themeId?: string;
  logoUrl?: string;
}

export const DEFAULT_CONFIG: RestaurantConfig = {
  agentName: "Bella",
  restaurantName: "The Roasted Bean",
  restaurantType: "cozy neighbourhood café",
  address: "123 Espresso Lane, Coffee City, CA 90210",
  phone: "(555) 123-4567",
  email: "hello@roastedbean.com",
  website: "www.roastedbean.com",
  instagram: "@roastedbean",
  tone: "warm and conversational",
  personality: "friendly, efficient, witty",
  priceRange: "$10–$25 per person",
  reservations: "Recommended for brunch, walk-ins welcome",
  reservationMethod: "Website or Phone",
  parking: "Free street parking available",
  seating: "Indoor + Outdoor patio",
  wifi: true,
  wifiPassword: "COFFEE_LOVER",
  kidFriendly: true,
  petFriendly: "Outdoor seating only",
  wheelchairAccessible: true,
  currency: "$",
  paymentMethods: ["Cash", "All major cards", "Apple Pay"],
  openingHours: {
    monday: { open: "08:00", close: "18:00", isClosed: false },
    tuesday: { open: "08:00", close: "18:00", isClosed: false },
    wednesday: { open: "08:00", close: "18:00", isClosed: false },
    thursday: { open: "08:00", close: "18:00", isClosed: false },
    friday: { open: "08:00", close: "20:00", isClosed: false },
    saturday: { open: "09:00", close: "20:00", isClosed: false },
    sunday: { open: "09:00", close: "16:00", isClosed: false },
  },
  menu: [
    {
      id: "cat1",
      name: "Coffee & Drinks",
      items: [
        { id: "i1", name: "Classic Latte", description: "Smooth espresso with steamed milk and a thin layer of foam.", price: "4.50", dietaryTags: [] },
        { id: "i2", name: "Cold Brew", description: "12-hour steeped specialty blend, served over ice.", price: "5.00", dietaryTags: [] },
      ],
    },
    {
      id: "cat2",
      name: "Brunch Mains",
      items: [
        { id: "i3", name: "Avocado Smash", description: "Poached eggs, feta, and sourdough with a hint of chili.", price: "16.00", dietaryTags: [] },
        { id: "i4", name: "Classic Benedict", description: "Two poached eggs on toasted English muffin with hollandaise.", price: "18.00", dietaryTags: [] },
      ],
    },
  ],
  specials: [
    { name: "Pumpkin Spice Latte", description: "Seasonal favorite with real pumpkin purée.", price: "5.50", period: "Fall Season" },
  ],
  signatureDishes: [
    "Avocado Smash — Our most popular brunch item for 5 years running.",
    "House Blend Cold Brew — Steeped for exactly 12 hours for peak smoothness.",
  ],
  themeId: "sienna",
  logoUrl: "",
};
