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
__maxPages__ sets maximum number of pagination pages to be crawled.  
__concurrency__ sets maximum number of parallel open browser pages.  
__checkIn__ check-in date in the mm-dd-yyyy format.  
__checkOut__ check-out date in the mm-dd-yyyy format.  
__currency__ preferred currency code to be set on the site.  
__language__ preferred language code to be set on the site.  
__proxyGroup__ Apify proxy group to be used.  
__sortBy__ sets a hotel attribute by which the results will be ordered, must be one of the following.

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
```

Instead of __search__ INPUT attribute, it is also possible to start the crawler with an array of __startUrls__.  
In such case all the other attributes modifying the URLs will still be applied, it is therefore suggested to  
use simple urls and set all the other options using INPUT attributes instead of leaving them in the URL to  
avoid URL parameter clashing.  
In case the startUrl is a hotel detail page, it will be scraped. In case it is a hotel list page, the result  
will depend on the __simple__ attribute. If it's __true__, the page will be scraped, otherwise all the links to  
detail pages will be added to the queue and scraped afterwards.  
The __startUrls__ attribute should cotain an array of URLs as follows:

```javascript
startUrls: [
    "https://www.booking.com/hotel/fr/ariane-montparnasse.en-gb.html",
    "https://www.booking.com/hotel/fr/heliosopera.en-gb.html",
    "https://www.booking.com/hotel/fr/ritz-paris-paris.en-gb.html",
    ...
]
```
