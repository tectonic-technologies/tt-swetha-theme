;(() => {
  if (window.__sai_prdwatch_initialized__) return
  window.__sai_prdwatch_initialized__ = true

  const SNIPPET_ID = 'prdwatch'
  const CLS = 'sai-prdwatch'
  const FEATURE_SLUG = 'product_watchlist'

  // Theme event names a few popular themes fire on variant selection.
  // Best-effort; no-op when the theme is silent.
  const THEME_VARIANT_EVENT_NAMES = [
    'variant:change',
    'product:variant-change',
    'variantChange',
  ]

  // Hidden input on the theme's add-to-cart form; widely standardized.
  const VARIANT_FORM_SELECTOR = 'form[action*="/cart/add"] [name="id"]'

  // URL ?variant= poll interval — covers themes that mutate the URL via
  // history.replaceState (no popstate fires) without burning CPU.
  const URL_POLL_MS = 250

  // Compact ISO country list. Shopper-facing combobox source. Order is
  // alphabetical except IN/US/GB pinned to the top for natural defaults.
  const COUNTRIES = [
    { c: 'IN', n: 'India', d: '+91', f: '🇮🇳' },
    { c: 'US', n: 'United States', d: '+1', f: '🇺🇸' },
    { c: 'GB', n: 'United Kingdom', d: '+44', f: '🇬🇧' },
    { c: 'AE', n: 'United Arab Emirates', d: '+971', f: '🇦🇪' },
    { c: 'AF', n: 'Afghanistan', d: '+93', f: '🇦🇫' },
    { c: 'AL', n: 'Albania', d: '+355', f: '🇦🇱' },
    { c: 'DZ', n: 'Algeria', d: '+213', f: '🇩🇿' },
    { c: 'AS', n: 'American Samoa', d: '+1684', f: '🇦🇸' },
    { c: 'AD', n: 'Andorra', d: '+376', f: '🇦🇩' },
    { c: 'AO', n: 'Angola', d: '+244', f: '🇦🇴' },
    { c: 'AI', n: 'Anguilla', d: '+1264', f: '🇦🇮' },
    { c: 'AG', n: 'Antigua and Barbuda', d: '+1268', f: '🇦🇬' },
    { c: 'AR', n: 'Argentina', d: '+54', f: '🇦🇷' },
    { c: 'AM', n: 'Armenia', d: '+374', f: '🇦🇲' },
    { c: 'AW', n: 'Aruba', d: '+297', f: '🇦🇼' },
    { c: 'AU', n: 'Australia', d: '+61', f: '🇦🇺' },
    { c: 'AT', n: 'Austria', d: '+43', f: '🇦🇹' },
    { c: 'AZ', n: 'Azerbaijan', d: '+994', f: '🇦🇿' },
    { c: 'BS', n: 'Bahamas', d: '+1242', f: '🇧🇸' },
    { c: 'BH', n: 'Bahrain', d: '+973', f: '🇧🇭' },
    { c: 'BD', n: 'Bangladesh', d: '+880', f: '🇧🇩' },
    { c: 'BB', n: 'Barbados', d: '+1246', f: '🇧🇧' },
    { c: 'BY', n: 'Belarus', d: '+375', f: '🇧🇾' },
    { c: 'BE', n: 'Belgium', d: '+32', f: '🇧🇪' },
    { c: 'BZ', n: 'Belize', d: '+501', f: '🇧🇿' },
    { c: 'BJ', n: 'Benin', d: '+229', f: '🇧🇯' },
    { c: 'BM', n: 'Bermuda', d: '+1441', f: '🇧🇲' },
    { c: 'BT', n: 'Bhutan', d: '+975', f: '🇧🇹' },
    { c: 'BO', n: 'Bolivia', d: '+591', f: '🇧🇴' },
    { c: 'BA', n: 'Bosnia and Herzegovina', d: '+387', f: '🇧🇦' },
    { c: 'BW', n: 'Botswana', d: '+267', f: '🇧🇼' },
    { c: 'BR', n: 'Brazil', d: '+55', f: '🇧🇷' },
    { c: 'IO', n: 'British Indian Ocean Territory', d: '+246', f: '🇮🇴' },
    { c: 'VG', n: 'British Virgin Islands', d: '+1284', f: '🇻🇬' },
    { c: 'BN', n: 'Brunei', d: '+673', f: '🇧🇳' },
    { c: 'BG', n: 'Bulgaria', d: '+359', f: '🇧🇬' },
    { c: 'BF', n: 'Burkina Faso', d: '+226', f: '🇧🇫' },
    { c: 'BI', n: 'Burundi', d: '+257', f: '🇧🇮' },
    { c: 'KH', n: 'Cambodia', d: '+855', f: '🇰🇭' },
    { c: 'CM', n: 'Cameroon', d: '+237', f: '🇨🇲' },
    { c: 'CA', n: 'Canada', d: '+1', f: '🇨🇦' },
    { c: 'CV', n: 'Cape Verde', d: '+238', f: '🇨🇻' },
    { c: 'KY', n: 'Cayman Islands', d: '+1345', f: '🇰🇾' },
    { c: 'CF', n: 'Central African Republic', d: '+236', f: '🇨🇫' },
    { c: 'TD', n: 'Chad', d: '+235', f: '🇹🇩' },
    { c: 'CL', n: 'Chile', d: '+56', f: '🇨🇱' },
    { c: 'CN', n: 'China', d: '+86', f: '🇨🇳' },
    { c: 'CX', n: 'Christmas Island', d: '+61', f: '🇨🇽' },
    { c: 'CC', n: 'Cocos Islands', d: '+61', f: '🇨🇨' },
    { c: 'CO', n: 'Colombia', d: '+57', f: '🇨🇴' },
    { c: 'KM', n: 'Comoros', d: '+269', f: '🇰🇲' },
    { c: 'CK', n: 'Cook Islands', d: '+682', f: '🇨🇰' },
    { c: 'CR', n: 'Costa Rica', d: '+506', f: '🇨🇷' },
    { c: 'HR', n: 'Croatia', d: '+385', f: '🇭🇷' },
    { c: 'CU', n: 'Cuba', d: '+53', f: '🇨🇺' },
    { c: 'CW', n: 'Curacao', d: '+599', f: '🇨🇼' },
    { c: 'CY', n: 'Cyprus', d: '+357', f: '🇨🇾' },
    { c: 'CZ', n: 'Czech Republic', d: '+420', f: '🇨🇿' },
    { c: 'CD', n: 'Democratic Republic of the Congo', d: '+243', f: '🇨🇩' },
    { c: 'DK', n: 'Denmark', d: '+45', f: '🇩🇰' },
    { c: 'DJ', n: 'Djibouti', d: '+253', f: '🇩🇯' },
    { c: 'DM', n: 'Dominica', d: '+1767', f: '🇩🇲' },
    { c: 'DO', n: 'Dominican Republic', d: '+1', f: '🇩🇴' },
    { c: 'EC', n: 'Ecuador', d: '+593', f: '🇪🇨' },
    { c: 'EG', n: 'Egypt', d: '+20', f: '🇪🇬' },
    { c: 'SV', n: 'El Salvador', d: '+503', f: '🇸🇻' },
    { c: 'GQ', n: 'Equatorial Guinea', d: '+240', f: '🇬🇶' },
    { c: 'ER', n: 'Eritrea', d: '+291', f: '🇪🇷' },
    { c: 'EE', n: 'Estonia', d: '+372', f: '🇪🇪' },
    { c: 'SZ', n: 'Eswatini', d: '+268', f: '🇸🇿' },
    { c: 'ET', n: 'Ethiopia', d: '+251', f: '🇪🇹' },
    { c: 'FK', n: 'Falkland Islands', d: '+500', f: '🇫🇰' },
    { c: 'FO', n: 'Faroe Islands', d: '+298', f: '🇫🇴' },
    { c: 'FJ', n: 'Fiji', d: '+679', f: '🇫🇯' },
    { c: 'FI', n: 'Finland', d: '+358', f: '🇫🇮' },
    { c: 'FR', n: 'France', d: '+33', f: '🇫🇷' },
    { c: 'PF', n: 'French Polynesia', d: '+689', f: '🇵🇫' },
    { c: 'GA', n: 'Gabon', d: '+241', f: '🇬🇦' },
    { c: 'GM', n: 'Gambia', d: '+220', f: '🇬🇲' },
    { c: 'GE', n: 'Georgia', d: '+995', f: '🇬🇪' },
    { c: 'DE', n: 'Germany', d: '+49', f: '🇩🇪' },
    { c: 'GH', n: 'Ghana', d: '+233', f: '🇬🇭' },
    { c: 'GI', n: 'Gibraltar', d: '+350', f: '🇬🇮' },
    { c: 'GR', n: 'Greece', d: '+30', f: '🇬🇷' },
    { c: 'GL', n: 'Greenland', d: '+299', f: '🇬🇱' },
    { c: 'GD', n: 'Grenada', d: '+1473', f: '🇬🇩' },
    { c: 'GU', n: 'Guam', d: '+1671', f: '🇬🇺' },
    { c: 'GT', n: 'Guatemala', d: '+502', f: '🇬🇹' },
    { c: 'GG', n: 'Guernsey', d: '+44', f: '🇬🇬' },
    { c: 'GN', n: 'Guinea', d: '+224', f: '🇬🇳' },
    { c: 'GW', n: 'Guinea-Bissau', d: '+245', f: '🇬🇼' },
    { c: 'GY', n: 'Guyana', d: '+592', f: '🇬🇾' },
    { c: 'HT', n: 'Haiti', d: '+509', f: '🇭🇹' },
    { c: 'HN', n: 'Honduras', d: '+504', f: '🇭🇳' },
    { c: 'HK', n: 'Hong Kong', d: '+852', f: '🇭🇰' },
    { c: 'HU', n: 'Hungary', d: '+36', f: '🇭🇺' },
    { c: 'IS', n: 'Iceland', d: '+354', f: '🇮🇸' },
    { c: 'ID', n: 'Indonesia', d: '+62', f: '🇮🇩' },
    { c: 'IR', n: 'Iran', d: '+98', f: '🇮🇷' },
    { c: 'IQ', n: 'Iraq', d: '+964', f: '🇮🇶' },
    { c: 'IE', n: 'Ireland', d: '+353', f: '🇮🇪' },
    { c: 'IM', n: 'Isle of Man', d: '+44', f: '🇮🇲' },
    { c: 'IL', n: 'Israel', d: '+972', f: '🇮🇱' },
    { c: 'IT', n: 'Italy', d: '+39', f: '🇮🇹' },
    { c: 'CI', n: 'Ivory Coast', d: '+225', f: '🇨🇮' },
    { c: 'JM', n: 'Jamaica', d: '+1876', f: '🇯🇲' },
    { c: 'JP', n: 'Japan', d: '+81', f: '🇯🇵' },
    { c: 'JE', n: 'Jersey', d: '+44', f: '🇯🇪' },
    { c: 'JO', n: 'Jordan', d: '+962', f: '🇯🇴' },
    { c: 'KZ', n: 'Kazakhstan', d: '+7', f: '🇰🇿' },
    { c: 'KE', n: 'Kenya', d: '+254', f: '🇰🇪' },
    { c: 'KI', n: 'Kiribati', d: '+686', f: '🇰🇮' },
    { c: 'XK', n: 'Kosovo', d: '+383', f: '🇽🇰' },
    { c: 'KW', n: 'Kuwait', d: '+965', f: '🇰🇼' },
    { c: 'KG', n: 'Kyrgyzstan', d: '+996', f: '🇰🇬' },
    { c: 'LA', n: 'Laos', d: '+856', f: '🇱🇦' },
    { c: 'LV', n: 'Latvia', d: '+371', f: '🇱🇻' },
    { c: 'LB', n: 'Lebanon', d: '+961', f: '🇱🇧' },
    { c: 'LS', n: 'Lesotho', d: '+266', f: '🇱🇸' },
    { c: 'LR', n: 'Liberia', d: '+231', f: '🇱🇷' },
    { c: 'LY', n: 'Libya', d: '+218', f: '🇱🇾' },
    { c: 'LI', n: 'Liechtenstein', d: '+423', f: '🇱🇮' },
    { c: 'LT', n: 'Lithuania', d: '+370', f: '🇱🇹' },
    { c: 'LU', n: 'Luxembourg', d: '+352', f: '🇱🇺' },
    { c: 'MO', n: 'Macau', d: '+853', f: '🇲🇴' },
    { c: 'MK', n: 'Macedonia', d: '+389', f: '🇲🇰' },
    { c: 'MG', n: 'Madagascar', d: '+261', f: '🇲🇬' },
    { c: 'MW', n: 'Malawi', d: '+265', f: '🇲🇼' },
    { c: 'MY', n: 'Malaysia', d: '+60', f: '🇲🇾' },
    { c: 'MV', n: 'Maldives', d: '+960', f: '🇲🇻' },
    { c: 'ML', n: 'Mali', d: '+223', f: '🇲🇱' },
    { c: 'MT', n: 'Malta', d: '+356', f: '🇲🇹' },
    { c: 'MH', n: 'Marshall Islands', d: '+692', f: '🇲🇭' },
    { c: 'MR', n: 'Mauritania', d: '+222', f: '🇲🇷' },
    { c: 'MU', n: 'Mauritius', d: '+230', f: '🇲🇺' },
    { c: 'MX', n: 'Mexico', d: '+52', f: '🇲🇽' },
    { c: 'FM', n: 'Micronesia', d: '+691', f: '🇫🇲' },
    { c: 'MD', n: 'Moldova', d: '+373', f: '🇲🇩' },
    { c: 'MC', n: 'Monaco', d: '+377', f: '🇲🇨' },
    { c: 'MN', n: 'Mongolia', d: '+976', f: '🇲🇳' },
    { c: 'ME', n: 'Montenegro', d: '+382', f: '🇲🇪' },
    { c: 'MS', n: 'Montserrat', d: '+1664', f: '🇲🇸' },
    { c: 'MA', n: 'Morocco', d: '+212', f: '🇲🇦' },
    { c: 'MZ', n: 'Mozambique', d: '+258', f: '🇲🇿' },
    { c: 'MM', n: 'Myanmar', d: '+95', f: '🇲🇲' },
    { c: 'NA', n: 'Namibia', d: '+264', f: '🇳🇦' },
    { c: 'NR', n: 'Nauru', d: '+674', f: '🇳🇷' },
    { c: 'NP', n: 'Nepal', d: '+977', f: '🇳🇵' },
    { c: 'NL', n: 'Netherlands', d: '+31', f: '🇳🇱' },
    { c: 'NC', n: 'New Caledonia', d: '+687', f: '🇳🇨' },
    { c: 'NZ', n: 'New Zealand', d: '+64', f: '🇳🇿' },
    { c: 'NI', n: 'Nicaragua', d: '+505', f: '🇳🇮' },
    { c: 'NE', n: 'Niger', d: '+227', f: '🇳🇪' },
    { c: 'NG', n: 'Nigeria', d: '+234', f: '🇳🇬' },
    { c: 'NU', n: 'Niue', d: '+683', f: '🇳🇺' },
    { c: 'KP', n: 'North Korea', d: '+850', f: '🇰🇵' },
    { c: 'NO', n: 'Norway', d: '+47', f: '🇳🇴' },
    { c: 'OM', n: 'Oman', d: '+968', f: '🇴🇲' },
    { c: 'PK', n: 'Pakistan', d: '+92', f: '🇵🇰' },
    { c: 'PW', n: 'Palau', d: '+680', f: '🇵🇼' },
    { c: 'PS', n: 'Palestine', d: '+970', f: '🇵🇸' },
    { c: 'PA', n: 'Panama', d: '+507', f: '🇵🇦' },
    { c: 'PG', n: 'Papua New Guinea', d: '+675', f: '🇵🇬' },
    { c: 'PY', n: 'Paraguay', d: '+595', f: '🇵🇾' },
    { c: 'PE', n: 'Peru', d: '+51', f: '🇵🇪' },
    { c: 'PH', n: 'Philippines', d: '+63', f: '🇵🇭' },
    { c: 'PL', n: 'Poland', d: '+48', f: '🇵🇱' },
    { c: 'PT', n: 'Portugal', d: '+351', f: '🇵🇹' },
    { c: 'PR', n: 'Puerto Rico', d: '+1', f: '🇵🇷' },
    { c: 'QA', n: 'Qatar', d: '+974', f: '🇶🇦' },
    { c: 'CG', n: 'Republic of the Congo', d: '+242', f: '🇨🇬' },
    { c: 'RE', n: 'Reunion', d: '+262', f: '🇷🇪' },
    { c: 'RO', n: 'Romania', d: '+40', f: '🇷🇴' },
    { c: 'RU', n: 'Russia', d: '+7', f: '🇷🇺' },
    { c: 'RW', n: 'Rwanda', d: '+250', f: '🇷🇼' },
    { c: 'BL', n: 'Saint Barthelemy', d: '+590', f: '🇧🇱' },
    { c: 'SH', n: 'Saint Helena', d: '+290', f: '🇸🇭' },
    { c: 'KN', n: 'Saint Kitts and Nevis', d: '+1869', f: '🇰🇳' },
    { c: 'LC', n: 'Saint Lucia', d: '+1758', f: '🇱🇨' },
    { c: 'PM', n: 'Saint Pierre and Miquelon', d: '+508', f: '🇵🇲' },
    { c: 'VC', n: 'Saint Vincent and the Grenadines', d: '+1784', f: '🇻🇨' },
    { c: 'WS', n: 'Samoa', d: '+685', f: '🇼🇸' },
    { c: 'SM', n: 'San Marino', d: '+378', f: '🇸🇲' },
    { c: 'ST', n: 'Sao Tome and Principe', d: '+239', f: '🇸🇹' },
    { c: 'SA', n: 'Saudi Arabia', d: '+966', f: '🇸🇦' },
    { c: 'SN', n: 'Senegal', d: '+221', f: '🇸🇳' },
    { c: 'RS', n: 'Serbia', d: '+381', f: '🇷🇸' },
    { c: 'SC', n: 'Seychelles', d: '+248', f: '🇸🇨' },
    { c: 'SL', n: 'Sierra Leone', d: '+232', f: '🇸🇱' },
    { c: 'SG', n: 'Singapore', d: '+65', f: '🇸🇬' },
    { c: 'SX', n: 'Sint Maarten', d: '+1721', f: '🇸🇽' },
    { c: 'SK', n: 'Slovakia', d: '+421', f: '🇸🇰' },
    { c: 'SI', n: 'Slovenia', d: '+386', f: '🇸🇮' },
    { c: 'SB', n: 'Solomon Islands', d: '+677', f: '🇸🇧' },
    { c: 'SO', n: 'Somalia', d: '+252', f: '🇸🇴' },
    { c: 'ZA', n: 'South Africa', d: '+27', f: '🇿🇦' },
    { c: 'KR', n: 'South Korea', d: '+82', f: '🇰🇷' },
    { c: 'SS', n: 'South Sudan', d: '+211', f: '🇸🇸' },
    { c: 'ES', n: 'Spain', d: '+34', f: '🇪🇸' },
    { c: 'LK', n: 'Sri Lanka', d: '+94', f: '🇱🇰' },
    { c: 'SD', n: 'Sudan', d: '+249', f: '🇸🇩' },
    { c: 'SR', n: 'Suriname', d: '+597', f: '🇸🇷' },
    { c: 'SE', n: 'Sweden', d: '+46', f: '🇸🇪' },
    { c: 'CH', n: 'Switzerland', d: '+41', f: '🇨🇭' },
    { c: 'SY', n: 'Syria', d: '+963', f: '🇸🇾' },
    { c: 'TW', n: 'Taiwan', d: '+886', f: '🇹🇼' },
    { c: 'TJ', n: 'Tajikistan', d: '+992', f: '🇹🇯' },
    { c: 'TZ', n: 'Tanzania', d: '+255', f: '🇹🇿' },
    { c: 'TH', n: 'Thailand', d: '+66', f: '🇹🇭' },
    { c: 'TL', n: 'Timor-Leste', d: '+670', f: '🇹🇱' },
    { c: 'TG', n: 'Togo', d: '+228', f: '🇹🇬' },
    { c: 'TK', n: 'Tokelau', d: '+690', f: '🇹🇰' },
    { c: 'TO', n: 'Tonga', d: '+676', f: '🇹🇴' },
    { c: 'TT', n: 'Trinidad and Tobago', d: '+1868', f: '🇹🇹' },
    { c: 'TN', n: 'Tunisia', d: '+216', f: '🇹🇳' },
    { c: 'TR', n: 'Turkey', d: '+90', f: '🇹🇷' },
    { c: 'TM', n: 'Turkmenistan', d: '+993', f: '🇹🇲' },
    { c: 'TC', n: 'Turks and Caicos Islands', d: '+1649', f: '🇹🇨' },
    { c: 'TV', n: 'Tuvalu', d: '+688', f: '🇹🇻' },
    { c: 'UG', n: 'Uganda', d: '+256', f: '🇺🇬' },
    { c: 'UA', n: 'Ukraine', d: '+380', f: '🇺🇦' },
    { c: 'UY', n: 'Uruguay', d: '+598', f: '🇺🇾' },
    { c: 'UZ', n: 'Uzbekistan', d: '+998', f: '🇺🇿' },
    { c: 'VU', n: 'Vanuatu', d: '+678', f: '🇻🇺' },
    { c: 'VA', n: 'Vatican City', d: '+39', f: '🇻🇦' },
    { c: 'VE', n: 'Venezuela', d: '+58', f: '🇻🇪' },
    { c: 'VN', n: 'Vietnam', d: '+84', f: '🇻🇳' },
    { c: 'WF', n: 'Wallis and Futuna', d: '+681', f: '🇼🇫' },
    { c: 'EH', n: 'Western Sahara', d: '+212', f: '🇪🇭' },
    { c: 'YE', n: 'Yemen', d: '+967', f: '🇾🇪' },
    { c: 'ZM', n: 'Zambia', d: '+260', f: '🇿🇲' },
    { c: 'ZW', n: 'Zimbabwe', d: '+263', f: '🇿🇼' },
  ]

  const COUNTRIES_BY_CODE = COUNTRIES.reduce((acc, country) => {
    acc[country.c] = country
    return acc
  }, {})

  const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
  // National-portion regex: user types the local number only (country code is
  // contributed by the picker). 6 covers Solomon Islands / Niue; 12 covers
  // long Russian/Chinese formats. Tighter than the legacy 7-15 which let
  // 13-digit garbage pass when concatenated with a dial code.
  const PHONE_NATIONAL_REGEX = /^\d{6,12}$/
  // Full-international fallback (only if the shopper pastes with a +).
  const PHONE_INTL_REGEX = /^\+\d{8,15}$/

  function safeTrack(track) {
    return (name, payload) => {
      if (typeof track !== 'function') return
      try {
        track(name, payload)
      } catch (_) {
        // analytics is best-effort
      }
    }
  }

  function safeEmit(emit) {
    return (name, payload) => {
      if (typeof emit !== 'function') return
      try {
        emit(name, payload)
      } catch (_) {}
    }
  }

  function readSnippetPool(wrapper) {
    const script = wrapper.querySelector('script[data-spectrum-snippet-pool]')
    if (!script || !script.textContent) return {}
    try {
      return JSON.parse(script.textContent)
    } catch (_) {
      return {}
    }
  }

  function readVariantIdFromUrl() {
    const params = new URLSearchParams(window.location.search)
    return params.get('variant')
  }

  function readVariantIdFromForm() {
    const input = document.querySelector(VARIANT_FORM_SELECTOR)
    if (!input) return null
    return input.value || null
  }

  // ---- Instance ----

  class NotifyMeInstance {
    constructor(wrapper) {
      this.wrapper = wrapper
      this.root = wrapper.querySelector(`.${CLS}`)
      this.pool = readSnippetPool(wrapper)
      this.variantsById = this._buildVariantsMap(this.pool.variants)
      this.currentVariantId = this._resolveInitialVariantId()
      this.defaultCountry = this.pool.defaultCountryCode || 'IN'
      // Confirmation auto-dismiss; 0 disables the timer (stays visible until
      // variant change). Bounded to a sane upper limit so a typo can't pin it
      // for an hour.
      const dismissRaw = this.pool.confirmationDismissSeconds
      this.confirmationDismissMs =
        typeof dismissRaw === 'number' && dismissRaw >= 0 ? Math.min(dismissRaw, 600) * 1000 : 15000
      this.confirmationTimer = null
      this.activeChannel = null
      this.modalOpenedAt = 0
      this.submitted = false
      this.urlPollTimer = null
      this.formObserver = null
      this.track = safeTrack(null)
      this.emit = safeEmit(null)

      this.triggerBtn = this.root && this.root.querySelector('[data-trigger]')
      this.modal = this.root && this.root.querySelector('[data-modal]')
      this.closeBtn = this.modal && this.modal.querySelector('[data-close]')
      this.form = this.modal && this.modal.querySelector('[data-form]')
      this.variantSelect = this.modal && this.modal.querySelector('[data-variant-select]')
      this.tabsEl = this.modal && this.modal.querySelector('[data-tabs]')
      this.emailField = this.modal && this.modal.querySelector('[data-channel-field="email"]')
      this.phoneField = this.modal && this.modal.querySelector('[data-channel-field="phone"]')
      this.emailInput = this.modal && this.modal.querySelector('[data-input="email"]')
      this.phoneInput = this.modal && this.modal.querySelector('[data-input="phone"]')
      this.submitBtn = this.modal && this.modal.querySelector('[data-submit]')
      // Confirmation lives OUTSIDE the dialog (sibling of the trigger button)
      // so it can stay visible after the modal closes. Query from the root, not
      // the modal. This was the bug behind the disappearing-snippet report.
      this.confirmation = this.root && this.root.querySelector('[data-confirmation]')

      this.activeChannel = this._defaultChannel()
    }

    setAnalytics(handles) {
      this.track = safeTrack(handles && handles.track)
      this.emit = safeEmit(handles && handles.emit)
    }

    init() {
      if (!this.root || !this.triggerBtn || !this.modal) return
      this._wireTrigger()
      this._wireClose()
      this._wireTabs()
      this._wireVariantSelect()
      this._wireCountryPicker()
      this._wireValidation()
      this._wireSubmit()
      this._subscribeVariantChanges()
      this._applyVariant(this.currentVariantId, { silent: true })
    }

    _buildVariantsMap(variants) {
      const map = {}
      if (!Array.isArray(variants)) return map
      for (const v of variants) {
        if (v && v.id != null) {
          map[String(v.id)] = { title: v.title, available: v.available === true }
        }
      }
      return map
    }

    _resolveInitialVariantId() {
      const fromUrl = readVariantIdFromUrl()
      if (fromUrl && this.variantsById[fromUrl]) return fromUrl
      const fromForm = readVariantIdFromForm()
      if (fromForm && this.variantsById[fromForm]) return fromForm
      if (this.pool.currentVariantId != null) return String(this.pool.currentVariantId)
      return null
    }

    // Channel values match the Email/SMS tab data-attributes and the analytics
    // payload contract ('email' | 'sms'). The "sms" channel maps to the phone
    // input/field internally — kept as 'sms' here because that's the merchant-
    // visible channel name and the analytics spec uses it.
    _defaultChannel() {
      if (this.emailField) return 'email'
      if (this.phoneField) return 'sms'
      return null
    }

    _wireTrigger() {
      this.triggerBtn.addEventListener('click', () => {
        this._openModal()
      })
    }

    _wireClose() {
      if (this.closeBtn) {
        this.closeBtn.addEventListener('click', () => this._closeModal())
      }
      // Backdrop click — native <dialog> click target is the dialog itself,
      // not the inner body.
      this.modal.addEventListener('click', (e) => {
        if (e.target === this.modal) this._closeModal()
      })
      this.modal.addEventListener('close', () => {
        this._onModalClosed()
      })
    }

    _wireTabs() {
      if (!this.tabsEl) return
      const tabs = this.tabsEl.querySelectorAll('[data-tab]')
      for (const tab of tabs) {
        tab.addEventListener('click', () => {
          const next = tab.getAttribute('data-tab')
          if (next === this.activeChannel) return
          this._switchChannel(next)
        })
      }
    }

    _switchChannel(next) {
      const from = this.activeChannel
      this.activeChannel = next
      const tabs = this.tabsEl ? this.tabsEl.querySelectorAll('[data-tab]') : []
      for (const tab of tabs) {
        const isActive = tab.getAttribute('data-tab') === next
        tab.setAttribute('aria-selected', String(isActive))
      }
      if (this.emailField) this.emailField.hidden = next !== 'email'
      if (this.phoneField) this.phoneField.hidden = next !== 'sms'
      // Hide any stale error from the previous channel so the inactive tab
      // doesn't carry red text into the next interaction.
      this._clearError('email')
      this._clearError('phone')
      this.track(`${FEATURE_SLUG}:channel_switch`, { from_channel: from, to_channel: next })
      this.emit(`${FEATURE_SLUG}:channel_switch`, { from_channel: from, to_channel: next })
      // Move focus into the newly-active input for keyboard users.
      const inputEl = next === 'email' ? this.emailInput : this.phoneInput
      if (inputEl) {
        setTimeout(() => inputEl.focus(), 0)
      }
    }

    _wireVariantSelect() {
      if (!this.variantSelect) return
      this.variantSelect.addEventListener('change', () => {
        const from = this.currentVariantId
        const to = this.variantSelect.value
        this.currentVariantId = to
        const meta = this.variantsById[to] || { available: false }
        this.track(`${FEATURE_SLUG}:variant_change`, {
          product_id: this.pool.product && this.pool.product.id,
          from_variant_id: from,
          to_variant_id: to,
          to_variant_available: meta.available,
        })
        this.emit(`${FEATURE_SLUG}:variant_change`, {
          product_id: this.pool.product && this.pool.product.id,
          from_variant_id: from,
          to_variant_id: to,
          to_variant_available: meta.available,
        })
      })
    }

    _wireCountryPicker() {
      if (!this.phoneField) return
      this.countryWrap = this.phoneField.querySelector('[data-country]')
      this.countryBtn = this.phoneField.querySelector('[data-country-button]')
      this.countryPopover = this.phoneField.querySelector('[data-country-popover]')
      this.countrySearch = this.phoneField.querySelector('[data-country-search]')
      this.countryList = this.phoneField.querySelector('[data-country-list]')
      this.countryFlag = this.phoneField.querySelector('[data-country-flag]')
      this.countryDial = this.phoneField.querySelector('[data-country-dial]')

      this.selectedCountry = COUNTRIES_BY_CODE[this.defaultCountry] || COUNTRIES_BY_CODE.IN
      this._renderCountryButton()
      this._renderCountryList('')

      this.countryBtn.addEventListener('click', () => {
        const open = this.countryPopover.getAttribute('data-open') === 'true'
        this._toggleCountryPopover(!open)
      })

      this.countrySearch.addEventListener('input', () => {
        this._renderCountryList(this.countrySearch.value.trim().toLowerCase())
      })

      this.countryList.addEventListener('click', (e) => {
        const target = e.target.closest('[data-country-code]')
        if (!target) return
        const code = target.getAttribute('data-country-code')
        const next = COUNTRIES_BY_CODE[code]
        if (next) {
          this.selectedCountry = next
          this._renderCountryButton()
          this._toggleCountryPopover(false)
        }
      })

      // Close popover on outside click.
      document.addEventListener('click', (e) => {
        if (!this.countryWrap) return
        if (this.countryPopover.getAttribute('data-open') !== 'true') return
        if (this.countryWrap.contains(e.target)) return
        this._toggleCountryPopover(false)
      })
    }

    _toggleCountryPopover(open) {
      this.countryPopover.setAttribute('data-open', String(open))
      this.countryBtn.setAttribute('aria-expanded', String(open))
      if (open) {
        setTimeout(() => this.countrySearch.focus(), 0)
      }
    }

    _renderCountryButton() {
      if (!this.selectedCountry) return
      this.countryFlag.textContent = this.selectedCountry.f
      this.countryDial.textContent = this.selectedCountry.d
    }

    _renderCountryList(query) {
      const filtered = query
        ? COUNTRIES.filter(
            (cn) =>
              cn.n.toLowerCase().includes(query) ||
              cn.d.includes(query) ||
              cn.c.toLowerCase().includes(query),
          )
        : COUNTRIES
      const html = filtered
        .map((cn) => {
          const selected = this.selectedCountry && cn.c === this.selectedCountry.c
          return `<li class="${CLS}__country-option" role="option" aria-selected="${selected}" data-country-code="${cn.c}"><span>${cn.f}</span><span>${cn.n}</span><span class="${CLS}__country-option-dial">${cn.d}</span></li>`
        })
        .join('')
      this.countryList.innerHTML = html
    }

    _wireValidation() {
      // Validation fires only on submit. Input event clears any prior error
      // as the shopper corrects their entry — no surprise red-text on blur.
      if (this.emailInput) {
        this.emailInput.addEventListener('input', () => this._clearError('email'))
      }
      if (this.phoneInput) {
        this.phoneInput.addEventListener('input', () => this._clearError('phone'))
      }
    }

    _validateEmail(showError) {
      const value = this.emailInput ? this.emailInput.value.trim() : ''
      if (!value) {
        if (showError) this._showError('email', 'Please enter your email.')
        return false
      }
      if (!EMAIL_REGEX.test(value)) {
        if (showError) this._showError('email', 'Enter a valid email address.')
        return false
      }
      this._clearError('email')
      return true
    }

    _validatePhone(showError) {
      const value = this.phoneInput ? this.phoneInput.value.replace(/[\s-]/g, '') : ''
      if (!value) {
        if (showError) this._showError('phone', 'Please enter your phone number.')
        return false
      }
      // If the shopper pasted international format ("+91…"), validate the
      // full string. Otherwise treat the typed value as the national portion
      // (6–12 digits) — the picker contributes the dial code at submit time.
      const isIntl = value.startsWith('+')
      const ok = isIntl ? PHONE_INTL_REGEX.test(value) : PHONE_NATIONAL_REGEX.test(value)
      if (!ok) {
        if (showError) this._showError('phone', 'Enter a valid phone number.')
        return false
      }
      this._clearError('phone')
      return true
    }

    _showError(field, message) {
      const el = this.modal.querySelector(`[data-error="${field}"]`)
      const input = field === 'email' ? this.emailInput : this.phoneInput
      if (el) {
        el.textContent = message
        el.hidden = false
      }
      if (input) input.classList.add(`${CLS}__input--error`)
    }

    _clearError(field) {
      const el = this.modal.querySelector(`[data-error="${field}"]`)
      const input = field === 'email' ? this.emailInput : this.phoneInput
      if (el) el.hidden = true
      if (input) input.classList.remove(`${CLS}__input--error`)
    }

    _wireSubmit() {
      if (!this.form) return
      this.form.addEventListener('submit', (e) => {
        e.preventDefault()
        this._handleSubmit()
      })
    }

    _handleSubmit() {
      const channel = this.activeChannel
      const productId = this.pool.product && this.pool.product.id
      const productHandle = this.pool.product && this.pool.product.handle
      const variantId = this.currentVariantId

      // Channel = 'email' | 'sms' (matches tab data-attribute); the SMS channel
      // maps to the phone input/field internally. Field-name in the validation
      // payload reflects which input was wrong, not the channel slug.
      const validators = {
        email: () => this._validateEmail(true),
        sms: () => this._validatePhone(true),
      }
      if (!channel || !validators[channel]) return
      if (!validators[channel]()) {
        const inputValue =
          channel === 'email'
            ? (this.emailInput && this.emailInput.value) || ''
            : (this.phoneInput && this.phoneInput.value) || ''
        this.track(`${FEATURE_SLUG}:validation_error`, {
          product_id: productId,
          variant_id: variantId,
          channel,
          field: channel === 'email' ? 'email' : 'phone',
          reason: inputValue.trim() === '' ? 'empty' : 'pattern_mismatch',
        })
        return
      }

      const customer = (window.__spectrumAi && window.__spectrumAi.customer) || null
      const hasPrefilledValue =
        !!customer &&
        ((channel === 'email' && customer.email && this.emailInput.value === customer.email) ||
          (channel === 'sms' && customer.phone && this.phoneInput.value === customer.phone))

      const submitPayload = {
        product_id: productId,
        variant_id: variantId,
        channel,
        has_prefilled_value: !!hasPrefilledValue,
      }
      if (channel === 'sms') {
        submitPayload.country_code = this.selectedCountry ? this.selectedCountry.d : null
      }

      this.track(`${FEATURE_SLUG}:submit`, submitPayload)
      this.emit(`${FEATURE_SLUG}:submit`, submitPayload)

      const fullPayload = {
        product_id: productId,
        product_handle: productHandle,
        variant_id: variantId,
        channel,
        email: channel === 'email' ? this.emailInput.value.trim() : null,
        phone:
          channel === 'sms'
            ? `${this.selectedCountry ? this.selectedCountry.d : ''}${this.phoneInput.value.replace(/[\s-]/g, '')}`
            : null,
        country_code: channel === 'sms' && this.selectedCountry ? this.selectedCountry.c : null,
      }

      // TODO: persistence. Wire Spectrum.notifyMe.subscribe(fullPayload) when
      // the backend endpoint lands. Until then, log so dev-store tests can see
      // the submission end-to-end.
      // eslint-disable-next-line no-console
      console.info('[spectrum.notify_me] submission (v1 — no persistence)', fullPayload)

      this.submitted = true
      // Lock the form so a quick double-tap can't fire submit twice.
      if (this.submitBtn) this.submitBtn.disabled = true
      if (this.form) {
        for (const input of this.form.querySelectorAll('input')) {
          input.disabled = true
        }
      }

      this.track(`${FEATURE_SLUG}:submit_success`, {
        product_id: productId,
        variant_id: variantId,
        channel,
      })
      this.emit(`${FEATURE_SLUG}:submit_success`, {
        product_id: productId,
        variant_id: variantId,
        channel,
      })

      // Close the modal, then surface the confirmation under the trigger.
      // The trigger stays visible — the shopper can re-open and switch
      // channels/variants if needed. Variant change clears the confirmation.
      this._closeModal()
      this._showConfirmation()
    }

    _showConfirmation() {
      if (!this.confirmation) return
      this.confirmation.hidden = false
      // Force a frame so the [data-visible] transition fires.
      requestAnimationFrame(() => {
        if (this.confirmation) this.confirmation.setAttribute('data-visible', 'true')
      })
      if (this.confirmationTimer) clearTimeout(this.confirmationTimer)
      if (this.confirmationDismissMs > 0) {
        this.confirmationTimer = setTimeout(() => {
          this._hideConfirmation()
        }, this.confirmationDismissMs)
      }
    }

    _hideConfirmation() {
      if (this.confirmationTimer) {
        clearTimeout(this.confirmationTimer)
        this.confirmationTimer = null
      }
      if (!this.confirmation) return
      this.confirmation.removeAttribute('data-visible')
      // Wait for the fade-out transition before hiding.
      setTimeout(() => {
        if (this.confirmation) this.confirmation.hidden = true
      }, 260)
    }

    _subscribeVariantChanges() {
      window.addEventListener('popstate', () => this._refreshFromExternal())
      let lastUrlVariant = readVariantIdFromUrl()
      this.urlPollTimer = setInterval(() => {
        const current = readVariantIdFromUrl()
        if (current !== lastUrlVariant) {
          lastUrlVariant = current
          this._refreshFromExternal()
        }
      }, URL_POLL_MS)
      window.addEventListener('pagehide', () => {
        if (this.urlPollTimer) clearInterval(this.urlPollTimer)
      })

      const formInput = document.querySelector(VARIANT_FORM_SELECTOR)
      if (formInput && typeof MutationObserver !== 'undefined') {
        this.formObserver = new MutationObserver(() => this._refreshFromExternal())
        this.formObserver.observe(formInput, { attributes: true, attributeFilter: ['value'] })
        formInput.addEventListener('change', () => this._refreshFromExternal())
      }

      for (const name of THEME_VARIANT_EVENT_NAMES) {
        document.addEventListener(name, (e) => {
          const detail = e && e.detail
          const id = detail && (detail.variantId || detail.variant_id || detail.id)
          if (id) this._applyVariant(String(id))
          else this._refreshFromExternal()
        })
      }
    }

    _refreshFromExternal() {
      const fromUrl = readVariantIdFromUrl()
      const fromForm = readVariantIdFromForm()
      const next = fromUrl || fromForm
      if (next && this.variantsById[next]) this._applyVariant(next)
    }

    _applyVariant(variantId, opts) {
      // Product Watchlist is NOT availability-gated — the trigger is always
      // visible whenever the snippet is on the page. We still listen for
      // variant changes so the modal's variant dropdown stays in sync with
      // whatever's selected on the PDP when the shopper opens it.
      const options = opts || {}
      if (!variantId) return
      const meta = this.variantsById[variantId]
      if (!meta) return
      const prevVariantId = this.currentVariantId
      this.currentVariantId = variantId
      if (this.variantSelect && this.variantSelect.value !== variantId) {
        this.variantSelect.value = variantId
      }
      if (options.silent) {
        this.track(`${FEATURE_SLUG}:trigger_impression`, {
          product_id: this.pool.product && this.pool.product.id,
          variant_id: variantId,
          variant_title: meta.title,
        })
        this.emit(`${FEATURE_SLUG}:trigger_impression`, {
          product_id: this.pool.product && this.pool.product.id,
          variant_id: variantId,
          variant_title: meta.title,
        })
      }
      if (prevVariantId !== variantId) {
        this._resetForm()
      }
    }

    _resetForm() {
      this.submitted = false
      this._hideConfirmation()
      if (this.submitBtn) this.submitBtn.disabled = false
      if (this.form) {
        for (const input of this.form.querySelectorAll('input')) {
          input.disabled = false
        }
      }
    }

    _openModal() {
      this._prefillFromCustomer()
      this.submitted = false
      this._clearError('email')
      this._clearError('phone')
      // Reset any stale confirmation state from a prior session, but DO NOT
      // hide the trigger here — the trigger stays visible until a successful
      // subscribe (see _handleSubmit) or until the variant changes.
      this._hideConfirmation()
      if (this.submitBtn) this.submitBtn.disabled = false
      // Re-enable every input — _handleSubmit locks them all after a
      // successful submit, and re-opening must restore a usable form.
      if (this.form) {
        for (const input of this.form.querySelectorAll('input')) {
          input.disabled = false
        }
      }
      this.modalOpenedAt = Date.now()
      const productId = this.pool.product && this.pool.product.id
      this.track(`${FEATURE_SLUG}:trigger_click`, {
        product_id: productId,
        variant_id: this.currentVariantId,
        variant_title:
          this.variantsById[this.currentVariantId] &&
          this.variantsById[this.currentVariantId].title,
      })
      this.emit(`${FEATURE_SLUG}:trigger_click`, {
        product_id: productId,
        variant_id: this.currentVariantId,
      })
      const surface = window.matchMedia('(max-width: 767px)').matches ? 'drawer' : 'modal'
      this.track(`${FEATURE_SLUG}:modal_open`, {
        product_id: productId,
        variant_id: this.currentVariantId,
        surface,
      })
      this.emit(`${FEATURE_SLUG}:modal_open`, {
        product_id: productId,
        variant_id: this.currentVariantId,
        surface,
      })
      // Cancel any prior animation + clear its safety-net timer so a fresh
      // open doesn't inherit any stale state from the previous cycle.
      if (this._modalAnim) {
        this._modalAnim.cancel()
        this._modalAnim = null
      }
      if (this._modalCloseTimer) {
        clearTimeout(this._modalCloseTimer)
        this._modalCloseTimer = null
      }
      // Defensive: explicitly clear any inline opacity/transform on the
      // body in case a prior WAAPI animation persisted a fill effect
      // that wasn't fully cleared by cancel().
      const modalBodyReset = this.modal.querySelector(`.${CLS}__modal-body`)
      if (modalBodyReset) {
        modalBodyReset.style.removeProperty('opacity')
        modalBodyReset.style.removeProperty('transform')
      }
      // WAAPI-driven open animation:
      // Element.animate() runs on the compositor with deterministic timing
      // and `fill: 'backwards'` applies the first keyframe's styles
      // immediately, so there's no first-paint race. The body therefore
      // starts at opacity 0 the instant showModal() opens the dialog and
      // animates to opacity 1 over 240ms.
      if (typeof this.modal.showModal === 'function') {
        this.modal.showModal()
      } else {
        this.modal.setAttribute('open', '')
      }
      const body = this.modal.querySelector(`.${CLS}__modal-body`)
      if (body && typeof body.animate === 'function') {
        const isMobile = window.matchMedia('(max-width: 767px)').matches
        const from = isMobile
          ? { opacity: 1, transform: 'translate3d(0, 100%, 0)' }
          : { opacity: 0, transform: 'translate3d(0, 0, 0)' }
        const to = { opacity: 1, transform: 'translate3d(0, 0, 0)' }
        this._modalAnim = body.animate([from, to], {
          duration: isMobile ? 320 : 240,
          easing: 'cubic-bezier(0.2, 0, 0, 1)',
          fill: 'backwards',
        })
      }
      requestAnimationFrame(() => this._lockBodyScroll(true))
      const firstInput =
        this.activeChannel === 'sms' && this.phoneInput ? this.phoneInput : this.emailInput
      if (firstInput) setTimeout(() => firstInput.focus(), 280)
    }

    _lockBodyScroll(lock) {
      const body = document.body
      if (!body) return
      if (lock) {
        // Compensate for the vanishing scrollbar so the page doesn't jolt
        // sideways when overflow flips to hidden — that visible shift is what
        // reads as "modal-open jitter" on stores with body-level scrolling.
        const scrollbarWidth = window.innerWidth - document.documentElement.clientWidth
        this._prevBodyOverflow = body.style.overflow
        this._prevBodyPaddingRight = body.style.paddingRight
        if (scrollbarWidth > 0) {
          const current = Number.parseFloat(getComputedStyle(body).paddingRight) || 0
          body.style.paddingRight = `${current + scrollbarWidth}px`
        }
        body.style.overflow = 'hidden'
      } else if (this._prevBodyOverflow !== undefined) {
        body.style.overflow = this._prevBodyOverflow
        body.style.paddingRight = this._prevBodyPaddingRight ?? ''
        this._prevBodyOverflow = undefined
        this._prevBodyPaddingRight = undefined
      }
    }

    _closeModal() {
      // Close instantly — no animation. See oosntfy1 _closeModal comment
      // for the rationale (close-anim state machine caused re-open bugs).
      if (this._modalAnim) {
        this._modalAnim.cancel()
        this._modalAnim = null
      }
      if (this._modalCloseTimer) {
        clearTimeout(this._modalCloseTimer)
        this._modalCloseTimer = null
      }
      if (typeof this.modal.close === 'function') {
        this.modal.close()
      } else {
        this.modal.removeAttribute('open')
        this._onModalClosed()
      }
    }

    _onModalClosed() {
      this._lockBodyScroll(false)
      const dwell = this.modalOpenedAt ? Date.now() - this.modalOpenedAt : 0
      this.modalOpenedAt = 0
      this.track(`${FEATURE_SLUG}:modal_close`, {
        product_id: this.pool.product && this.pool.product.id,
        variant_id: this.currentVariantId,
        submitted: this.submitted,
        dwell_ms: dwell,
      })
      this.emit(`${FEATURE_SLUG}:modal_close`, {
        product_id: this.pool.product && this.pool.product.id,
        variant_id: this.currentVariantId,
        submitted: this.submitted,
        dwell_ms: dwell,
      })
    }

    _prefillFromCustomer() {
      // Liquid SSRs `customer.email` / `customer.phone` into the pool when the
      // shopper is logged in — that's the reliable source on a Shopify storefront.
      // `__spectrumAi.customer` is a fallback for stores that have the runtime
      // SDK populating it but no theme-side identity.
      const poolCustomer =
        (this.pool && this.pool.customer && (this.pool.customer.email || this.pool.customer.phone))
          ? this.pool.customer
          : null
      const sdkCustomer =
        (window.__spectrumAi && window.__spectrumAi.customer) || null
      const customer = poolCustomer || sdkCustomer
      if (!customer) return
      if (this.emailInput && customer.email && !this.emailInput.value) {
        this.emailInput.value = customer.email
      }
      if (this.phoneInput && customer.phone && !this.phoneInput.value) {
        // Strip leading dial-code if it matches the currently-selected country
        // so the input shows the national portion only.
        const phone = String(customer.phone)
        const dial = this.selectedCountry ? this.selectedCountry.d : ''
        this.phoneInput.value = dial && phone.startsWith(dial) ? phone.slice(dial.length) : phone
      }
      // Switch to the channel that has a prefilled value, if tabs are present.
      if (this.tabsEl) {
        const hasEmail = !!(this.emailInput && this.emailInput.value)
        const hasPhone = !!(this.phoneInput && this.phoneInput.value)
        if (hasEmail) this._switchChannel('email')
        else if (hasPhone) this._switchChannel('sms')
      }
    }
  }

  // ---- Bind ----

  function bindAllContainers() {
    const containers = document.querySelectorAll(
      `[data-spectrum-instance-id][data-spectrum-snippet-id="${SNIPPET_ID}"]`,
    )
    const snippetApi = window.__spectrumAi && window.__spectrumAi.snippet

    for (const wrapper of containers) {
      if (wrapper.__sai_prdwatch_bound__) continue
      wrapper.__sai_prdwatch_bound__ = true

      const inst = new NotifyMeInstance(wrapper)
      inst.init()

      if (snippetApi && typeof snippetApi.bind === 'function') {
        const handles = snippetApi.bind(wrapper, () => {
          /* applyVariant cb intentionally a no-op — variant content is
             baked at SSR; we don't need re-renders on Studio variant
             switches for this snippet. */
        })
        if (handles) inst.setAnalytics(handles)
      }
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bindAllContainers, { once: true })
  } else {
    bindAllContainers()
  }

  if (typeof globalThis !== 'undefined' && globalThis.__SAI_TEST_HARNESS__ === true) {
    globalThis.__saiPrdwatch = {
      COUNTRIES,
      COUNTRIES_BY_CODE,
      EMAIL_REGEX,
      PHONE_NATIONAL_REGEX,
      PHONE_INTL_REGEX,
      NotifyMeInstance,
    }
  }
})()
