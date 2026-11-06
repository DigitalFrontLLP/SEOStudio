/**
 * GOOGLE'S RICH RESULT PROPERTY TABLES, vendored: for each schema.org type Google shows a rich result
 * for, the properties its Search Central documentation calls REQUIRED and RECOMMENDED, and the types it
 * shows no rich result for any more. Read from the pages under {@link SEO_RICH_RESULTS_SOURCE} on
 * {@link SEO_RICH_RESULTS_RETRIEVED}; re-read them when Google changes a feature.
 *
 * NOTATION: a requirement is a property path; a dotted path (`offers.price`) applies to each value of
 * its parent and only when the parent is present (the parent's own requirement covers its absence);
 * `a|b` is satisfied by either. A type's entry applies to its subtypes too (a `Restaurant` is checked as
 * a `LocalBusiness`), the most specific entry winning. `nested` is the set a type must meet when it sits
 * inside another item (a `Review` in a `Product` needs no `itemReviewed`); a type without `nested` is
 * judged only as a top-level item.
 *
 * Organization keeps only the name, url and logo every organization has: Google's other recommended
 * properties (an address, a telephone, a legal name, ...) apply only to some, and asking every site for
 * them would file a gap on a healthy page.
 *
 * LEFT OUT ON PURPOSE (they would fire on pages that never asked for the feature): the merchant listing,
 * shipping, return policy, member program, carousel, image license, paywall, book action, vacation
 * rental, math solver and flashcard sets (each needs a context the markup alone does not show), and
 * Organization's merchant identifiers.
 */

/** When the tables were read from Google's documentation. */
export const SEO_RICH_RESULTS_RETRIEVED = "2026-10-07";

/** Where the tables were read: each entry's `source` is a page under it. */
export const SEO_RICH_RESULTS_SOURCE =
	"https://developers.google.com/search/docs/appearance/structured-data/";

/** One set of requirements: the paths Google calls required and recommended. */
export interface RichResultRequirements {
	required: readonly string[];
	recommended: readonly string[];
}

/** One rich result type: its documentation page, its top-level set, and its set when nested. */
export interface RichResultSpec extends RichResultRequirements {
	/** The documentation page the set was read from. */
	source: string;
	/** The set when the item sits inside another item, or undefined when it is judged only at the top. */
	nested?: RichResultRequirements;
}

/**
 * A spec entry.
 *
 * @param page - The documentation page's slug.
 * @param required - The required paths.
 * @param recommended - The recommended paths.
 * @param nested - The set when nested, if judged there.
 * @returns The entry.
 */
function spec(
	page: string,
	required: readonly string[],
	recommended: readonly string[],
	nested?: RichResultRequirements
): RichResultSpec {
	return {
		source: `${SEO_RICH_RESULTS_SOURCE}${page}`,
		required,
		recommended,
		...(nested === undefined ? {} : { nested })
	};
}

const DISCUSSION = spec(
	"discussion-forum",
	[
		"author",
		"author.name",
		"datePublished",
		"text|image|video",
		"comment.author",
		"comment.datePublished",
		"comment.text|comment.image|comment.video",
		"interactionStatistic.interactionType",
		"interactionStatistic.userInteractionCount"
	],
	[
		"author.url",
		"commentCount",
		"dateModified",
		"headline",
		"image",
		"interactionStatistic",
		"isPartOf",
		"url"
	]
);

/**
 * Google's article set. `BlogPosting` is a `SocialMediaPosting` in schema.org, but Google reads blog
 * posts as articles, so it is listed here and never judged as a forum post. An article's author and
 * dates are judged once, by `eeat_signals` and `content_date_missing`, so they are left out here.
 */
const ARTICLE = spec("article", [], ["author.name", "author.url", "headline", "image"]);

const REVIEW_RECOMMENDED = ["datePublished", "reviewRating.bestRating", "reviewRating.worstRating"];

const SOFTWARE = spec(
	"software-app",
	["name", "offers", "offers.price|offers.lowPrice", "aggregateRating|review"],
	["applicationCategory", "operatingSystem"]
);

const VIDEO_RECOMMENDED = [
	"contentUrl",
	"description",
	"duration",
	"embedUrl",
	"interactionStatistic"
];

/** The rich result types, by schema.org type. */
export const SEO_RICH_RESULT_SPECS: Readonly<Record<string, RichResultSpec>> = {
	Article: ARTICLE,
	BlogPosting: ARTICLE,
	LiveBlogPosting: ARTICLE,
	BreadcrumbList: spec(
		"breadcrumb",
		[
			"itemListElement",
			"itemListElement.position",
			"itemListElement.name|itemListElement.item.name"
		],
		[]
	),
	Course: spec("course", ["name", "description"], ["provider"]),
	Dataset: spec(
		"dataset",
		["name", "description", "distribution.contentUrl"],
		[
			"creator",
			"citation",
			"funder",
			"identifier",
			"isAccessibleForFree",
			"keywords",
			"license",
			"measurementTechnique",
			"sameAs",
			"spatialCoverage",
			"temporalCoverage",
			"variableMeasured",
			"version",
			"url",
			"includedInDataCatalog",
			"distribution",
			"distribution.encodingFormat"
		]
	),
	DiscussionForumPosting: DISCUSSION,
	SocialMediaPosting: DISCUSSION,
	EmployerAggregateRating: spec(
		"employer-rating",
		["itemReviewed", "ratingValue", "ratingCount|reviewCount"],
		["bestRating", "worstRating"]
	),
	Event: spec(
		"event",
		["name", "startDate", "location", "location.address|location.url"],
		[
			"description",
			"endDate",
			"eventStatus",
			"image",
			"location.name",
			"offers",
			"offers.availability",
			"offers.price",
			"offers.priceCurrency",
			"offers.validFrom",
			"offers.url",
			"organizer",
			"organizer.name",
			"organizer.url",
			"performer",
			"performer.name"
		]
	),
	JobPosting: spec(
		"job-posting",
		["datePosted", "description", "hiringOrganization", "jobLocation|jobLocationType", "title"],
		[
			"applicantLocationRequirements",
			"baseSalary",
			"directApply",
			"employmentType",
			"identifier",
			"validThrough"
		]
	),
	LocalBusiness: spec(
		"local-business",
		["name", "address"],
		[
			"aggregateRating",
			"geo",
			"geo.latitude",
			"geo.longitude",
			"openingHoursSpecification",
			"priceRange",
			"review",
			"telephone",
			"url"
		]
	),
	Movie: spec("movie", ["name", "image"], ["aggregateRating", "dateCreated", "director", "review"]),
	Organization: spec("organization", [], ["name", "url", "logo"]),
	Product: spec(
		"product-snippet",
		[
			"name",
			"offers|review|aggregateRating",
			"offers.price|offers.priceSpecification.price|offers.lowPrice"
		],
		[
			"aggregateRating",
			"offers",
			"review",
			"offers.availability",
			"offers.priceCurrency|offers.priceSpecification.priceCurrency",
			"offers.priceValidUntil"
		]
	),
	AggregateOffer: spec(
		"product-snippet",
		["lowPrice", "priceCurrency"],
		["highPrice", "offerCount"],
		{ required: ["lowPrice", "priceCurrency"], recommended: ["highPrice", "offerCount"] }
	),
	ProductGroup: spec(
		"product-variants",
		["name"],
		[
			"aggregateRating",
			"brand",
			"description",
			"hasVariant",
			"productGroupID",
			"review",
			"url",
			"variesBy"
		]
	),
	ProfilePage: spec(
		"profile-page",
		["mainEntity", "mainEntity.name"],
		[
			"dateCreated",
			"dateModified",
			"mainEntity.alternateName",
			"mainEntity.description",
			"mainEntity.identifier",
			"mainEntity.image",
			"mainEntity.sameAs",
			"mainEntity.interactionStatistic"
		]
	),
	QAPage: spec(
		"qapage",
		[
			"mainEntity",
			"mainEntity.name",
			"mainEntity.answerCount",
			"mainEntity.acceptedAnswer|mainEntity.suggestedAnswer",
			"mainEntity.acceptedAnswer.text",
			"mainEntity.suggestedAnswer.text"
		],
		[
			"mainEntity.author",
			"mainEntity.datePublished",
			"mainEntity.text",
			"mainEntity.acceptedAnswer.author",
			"mainEntity.acceptedAnswer.datePublished",
			"mainEntity.acceptedAnswer.upvoteCount",
			"mainEntity.acceptedAnswer.url"
		]
	),
	Recipe: spec(
		"recipe",
		["name", "image"],
		[
			"aggregateRating",
			"author",
			"cookTime",
			"datePublished",
			"description",
			"keywords",
			"nutrition.calories",
			"prepTime",
			"recipeCategory",
			"recipeCuisine",
			"recipeIngredient",
			"recipeInstructions",
			"recipeYield",
			"totalTime",
			"video"
		]
	),
	Review: spec(
		"review-snippet",
		["author", "itemReviewed", "itemReviewed.name", "reviewRating", "reviewRating.ratingValue"],
		REVIEW_RECOMMENDED,
		{
			required: ["author", "reviewRating", "reviewRating.ratingValue"],
			recommended: REVIEW_RECOMMENDED
		}
	),
	AggregateRating: spec(
		"review-snippet",
		["itemReviewed", "itemReviewed.name", "ratingValue", "ratingCount|reviewCount"],
		["bestRating", "worstRating"],
		{
			required: ["ratingValue", "ratingCount|reviewCount"],
			recommended: ["bestRating", "worstRating"]
		}
	),
	SoftwareApplication: SOFTWARE,
	VideoObject: spec("video", ["name", "thumbnailUrl", "uploadDate"], VIDEO_RECOMMENDED, {
		required: ["name", "thumbnailUrl", "uploadDate"],
		recommended: VIDEO_RECOMMENDED
	}),
	Clip: spec("video", ["name", "startOffset", "url"], ["endOffset"], {
		required: ["name", "startOffset", "url"],
		recommended: ["endOffset"]
	})
};

/** Why a type earns no rich result: the feature is gone, or kept for a few sites or one surface. */
export type RetiredSchemaReason = "retired" | "limited";

/**
 * The types Google shows no rich result for any more, with the day that happened, from Google's Search
 * Central updates (`https://developers.google.com/search/updates`). `SearchAction` is the sitelinks
 * search box (a `WebSite`'s `potentialAction`); the `WebSite` itself still names the site.
 */
export const SEO_RETIRED_SCHEMA_TYPES: Readonly<
	Record<string, { since: string; reason: RetiredSchemaReason }>
> = {
	HowTo: { since: "2023-09-13", reason: "retired" },
	SearchAction: { since: "2024-11-21", reason: "retired" },
	SpecialAnnouncement: { since: "2025-07-31", reason: "retired" },
	ClaimReview: { since: "2025-09-09", reason: "limited" },
	Car: { since: "2025-09-09", reason: "retired" },
	Occupation: { since: "2025-09-09", reason: "retired" },
	OccupationAggregationByEmployer: { since: "2025-09-09", reason: "retired" },
	FAQPage: { since: "2026-05-07", reason: "retired" }
};
