# actor-booking-hotels

Apify actor for extracting data about hotels from Booking.com.

This actor extracts hotel data from Booking.com, it can either extract directly from  
the hotel list page or navigate to the detail page to get more detailed information.  
The results can be ordered by any criteria supported by Booking.com.

**INPUT**

Input is a JSON object with the following properties:

```javascript
{
    "search": SEARCH_QUERY,
    "simple": EXTRACT_FROM_LIST,
    "minScore": MINIMUM_HOTEL_RATING,
    "maxPages": MAXIMUM_PAGINATION_PAGES,
    "concurrency": MAXIMUM_CONCURRENT_PAGES,
    "checkIn": CHECK_IN_DATE, 
    "checkOut": CHECK_OUT_DATE, 
    "currency": PREFERRED_CURRENCY,
    "language": PREFERRED_LANGUAGE,
    "proxyGroup": PROXY_GROUP,
    "sortBy": BOOKING_SORT_TYPE
}
```

__search__ is the only required attribute. This is the Booking.com search query.  
__simple__ defines if the data should be extracted just from the list page, default is __false__.  
__minScore__ specifies the minimum allowed rating of the hotel to be included in results, default is __8.4__.  
__maxPages__ sets maximum nuber of pagination pages to be crawled.  
__concurrency__ sets maximum nuber of parallel open browser pages.  
__checkIn__ check-in date in the mm-dd-yyyy format.  
__checkOut__ check-out date in the mm-dd-yyyy format.  
__currency__ preferred currency code to be set on the site.  
__language__ preferred language code to be set on the site.  
__proxyGroup__ Apify proxy group to be used.  
__sortBy__ set a hotel attribute by which the results will be ordered, must be one of the following.  
```javascript
[
    "bayesian_review_score",    // Rating
    "popularity",               // Popularity
    "price",                    // Price
    "review_score_and_price",   // Rating and price
    "class",                    // Stars
    "class_asc",                // Stars ascending
    "distance_from_landmark"    // Distance from city centre
]
